import { normalizeLaunchpadPlatform } from '@/constants/launchpad';

const FLAP_SUFFIXES = ['7777', '8888'];
const FOUR_MEME_SUFFIXES = ['4444', 'ffff'];

const FOUR_MEME_PLATFORM_SET = new Set([
  'fourmeme',
  'bn_fourmeme',
  'fourmeme_agent',
  'four_xmode_agent',
  'xmode',
  'xmode_agent',
]);

export type LaunchpadFamily = 'flap' | 'fourmeme' | null;

export function isFlapSuffixAddress(address?: string | null): boolean {
  const lower = String(address || '').trim().toLowerCase();
  return FLAP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function isFourMemeSuffixAddress(address?: string | null): boolean {
  const lower = String(address || '').trim().toLowerCase();
  return FOUR_MEME_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function inferLaunchpadFamilyByAddress(address?: string | null): LaunchpadFamily {
  if (isFlapSuffixAddress(address)) return 'flap';
  if (isFourMemeSuffixAddress(address)) return 'fourmeme';
  return null;
}

export function resolveTokenLaunchpadPlatform(input: {
  address?: string | null;
  launchpad?: unknown;
  launchpad_platform?: unknown;
  requestedPlatform?: unknown;
}): string {
  const normalized = normalizeLaunchpadPlatform(
    input.launchpad_platform ?? input.launchpad ?? input.requestedPlatform,
  ) ?? String(input.launchpad_platform ?? input.launchpad ?? input.requestedPlatform ?? '').trim().toLowerCase();
  const family = inferLaunchpadFamilyByAddress(input.address);
  if (family === 'flap') {
    return normalized.startsWith('flap') ? normalized : 'flap';
  }
  if (family === 'fourmeme') {
    return FOUR_MEME_PLATFORM_SET.has(normalized) ? normalized : 'fourmeme';
  }
  return normalized;
}
