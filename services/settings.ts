import { browser } from 'wxt/browser';
import { getSettings, setSettings, SETTINGS_STORAGE_KEY } from './storage';
import { validateSettings } from '../utils/validate';
import { defaultSettings } from '../utils/defaults';
import type { Settings } from '../types/extention';

export class SettingsService {
  private static cached: Settings | null = null;
  private static loading: Promise<Settings> | null = null;
  private static listenerBound = false;

  private static bindStorageListener() {
    if (SettingsService.listenerBound) return;
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const changed = changes?.[SETTINGS_STORAGE_KEY];
      if (!changed) return;
      const next = changed.newValue;
      if (next && typeof next === 'object') {
        const validated = validateSettings(next as Settings) ?? defaultSettings();
        SettingsService.cached = validated;
        return;
      }
      SettingsService.cached = null;
      SettingsService.loading = null;
    });
    SettingsService.listenerBound = true;
  }

  static async get(): Promise<Settings> {
    SettingsService.bindStorageListener();
    if (SettingsService.cached) return SettingsService.cached;
    if (SettingsService.loading) return SettingsService.loading;
    SettingsService.loading = (async () => {
      try {
        const loaded = await getSettings();
        SettingsService.cached = loaded;
        return loaded;
      } finally {
        SettingsService.loading = null;
      }
    })();
    return SettingsService.loading;
  }

  static async update(partial: Partial<Settings>): Promise<void> {
    SettingsService.bindStorageListener();
    const current = await SettingsService.get();
    const merged = { ...current, ...partial };
    const validated = validateSettings(merged) ?? defaultSettings();
    await setSettings(validated);
    SettingsService.cached = validated;
  }
}
