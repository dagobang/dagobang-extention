import { browser } from 'wxt/browser';
import type { Settings, WalletPayload, Account } from '../types/extention';
import { defaultSettings } from '../utils/defaults';

const KEYS = {
  wallet: 'db_wallet_v1',
  settings: 'db_settings_v1',
  unlocked: 'db_unlocked_v1',
} as const;

export type StoredWallet = {
  version: 1;
  payload: {
    iv: string;
    salt: string;
    ciphertext: string;
  };
};

export type UnlockedState = {
  accounts: Account[];
  selectedAddress: `0x${string}`;
  expiresAt?: number;
};

export async function getStoredWallet(): Promise<StoredWallet | null> {
  const res = await browser.storage.local.get(KEYS.wallet);
  return (res[KEYS.wallet] as StoredWallet) || null;
}

export async function setStoredWallet(wallet: StoredWallet | null): Promise<void> {
  if (wallet) {
    await browser.storage.local.set({ [KEYS.wallet]: wallet });
  } else {
    await browser.storage.local.remove(KEYS.wallet);
  }
}

export async function getSettings(): Promise<Settings> {
  const res = await browser.storage.local.get(KEYS.settings);
  return (res[KEYS.settings] as Settings) || defaultSettings();
}

export async function setSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [KEYS.settings]: settings });
}

export async function getUnlockedState(): Promise<UnlockedState | null> {
  try {
    const res = await browser.storage.session.get(KEYS.unlocked);
    const state = res[KEYS.unlocked] as UnlockedState;
    if (!state) return null;
    
    if (state.expiresAt && Date.now() > state.expiresAt) {
      await clearUnlockedState();
      return null;
    }
    
    return state;
  } catch (e) {
    console.error('Failed to get unlocked state', e);
    return null;
  }
}

export async function setUnlockedState(state: UnlockedState): Promise<void> {
  await browser.storage.session.set({ [KEYS.unlocked]: state });
}

export async function clearUnlockedState(): Promise<void> {
  await browser.storage.session.remove(KEYS.unlocked);
}
