import { browser } from 'wxt/browser';
import type { Settings, WalletPayload, Account, LimitOrder, MultiChainWalletPayload, UniversalAccount } from '../types/extention';
import type { ChainAddress, ChainAccountKind } from '../types/chain';
import { defaultSettings } from '../utils/defaults';
import { validateSettings } from '../utils/validate';

const KEYS = {
  wallet: 'db_wallet_v1',
  walletSolana: 'db_wallet_solana_v1',
  settings: 'db_settings_v1',
  unlocked: 'db_unlocked_v1',
  unlockedSolana: 'db_unlocked_solana_v1',
  limitOrders: 'db_limit_orders_v1',
} as const;
export const SETTINGS_STORAGE_KEY = KEYS.settings;

export type StoredWallet = {
  version: 1;
  payload: {
    iv: string;
    salt: string;
    ciphertext: string;
  };
};

export type StoredMultiChainWallet = {
  version: 2;
  payload: StoredWallet['payload'];
};

export type UnlockedState = {
  accounts: Account[];
  selectedAddress: `0x${string}`;
  mnemonic?: string;
  expiresAt?: number;
};

export type MultiChainUnlockedGroup = {
  kind: ChainAccountKind;
  accounts: UniversalAccount[];
  selectedAddress?: ChainAddress;
};

export type UnlockedSolanaState = MultiChainUnlockedGroup & {
  expiresAt?: number;
};

export type MultiChainUnlockedState = {
  activeChainId?: number;
  wallets: Partial<Record<ChainAccountKind, MultiChainUnlockedGroup>>;
  expiresAt?: number;
};

export type WalletPayloadLike = WalletPayload | MultiChainWalletPayload;

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
  const stored = (res[KEYS.settings] as Settings | undefined) || null;
  if (!stored) return defaultSettings();
  const normalized = validateSettings(stored);
  if (!normalized) return defaultSettings();
  if (JSON.stringify(normalized) !== JSON.stringify(stored)) {
    await browser.storage.local.set({ [KEYS.settings]: normalized });
  }
  return normalized;
}

export async function getStoredSolanaWallet(): Promise<StoredMultiChainWallet | null> {
  const res = await browser.storage.local.get(KEYS.walletSolana);
  return (res[KEYS.walletSolana] as StoredMultiChainWallet) || null;
}

export async function setStoredSolanaWallet(wallet: StoredMultiChainWallet | null): Promise<void> {
  if (wallet) {
    await browser.storage.local.set({ [KEYS.walletSolana]: wallet });
  } else {
    await browser.storage.local.remove(KEYS.walletSolana);
  }
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

export async function getUnlockedSolanaState(): Promise<UnlockedSolanaState | null> {
  try {
    const res = await browser.storage.session.get(KEYS.unlockedSolana);
    const state = res[KEYS.unlockedSolana] as UnlockedSolanaState | undefined;
    if (!state) {
      return null;
    }
    if (state.expiresAt && Date.now() > state.expiresAt) {
      await clearUnlockedSolanaState();
      return null;
    }
    return state;
  } catch (e) {
    console.error('Failed to get unlocked solana state', e);
    return null;
  }
}

export async function setUnlockedSolanaState(state: UnlockedSolanaState): Promise<void> {
  await browser.storage.session.set({ [KEYS.unlockedSolana]: state });
}

export async function clearUnlockedState(): Promise<void> {
  await browser.storage.session.remove(KEYS.unlocked);
}

export async function clearUnlockedSolanaState(): Promise<void> {
  await browser.storage.session.remove(KEYS.unlockedSolana);
}

export async function getLimitOrders(): Promise<LimitOrder[]> {
  const res = await browser.storage.local.get(KEYS.limitOrders);
  const stored = res[KEYS.limitOrders] as unknown;
  if (!Array.isArray(stored)) return [];
  return stored as LimitOrder[];
}

export async function setLimitOrders(orders: LimitOrder[]): Promise<void> {
  await browser.storage.local.set({ [KEYS.limitOrders]: orders });
}
