import { getSettings, setSettings } from './storage';
import { validateSettings } from '../utils/validate';
import { defaultSettings } from '../utils/defaults';
import type { Settings } from '../types/extention';

export class SettingsService {
  static async get(): Promise<Settings> {
    return getSettings();
  }

  static async update(partial: Partial<Settings>): Promise<void> {
    const current = await getSettings();
    const merged = { ...current, ...partial };
    const validated = validateSettings(merged) ?? defaultSettings();
    await setSettings(validated);
  }
}
