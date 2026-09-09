import type { CookingLaunchPlatform } from './types';

export const COOKING_PANEL_WIDTH = 360;
export const COOKING_PANEL_MIN_HEIGHT = 420;
export const COOKING_PANEL_DEFAULT_HEIGHT = 700;
export const COOKING_CONFIG_STORAGE_KEY = 'dagobang_cooking_config_v2';
export const MAX_AUTO_SELL_RULES = 5;
export const FLAP_TAX_RATE_OPTIONS = [100, 300, 500, 1000] as const;

export const COOKING_PLATFORMS: Array<{ value: CookingLaunchPlatform; label: string }> = [
  { value: 'fourmeme', label: 'Four' },
  { value: 'openfour', label: 'OpenFour' },
  { value: 'flap', label: 'Flap' },
  { value: 'flap_stocks', label: 'Flap Stocks' },
];
