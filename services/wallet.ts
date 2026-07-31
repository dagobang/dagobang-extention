import { generateMnemonic, english, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { encryptJson, decryptJson } from '../utils/crypto';
import { normalizeHexPrivateKey } from '../utils/format';
import { getStoredWallet, setStoredWallet, getUnlockedState, setUnlockedState, clearUnlockedState, getSettings, setSettings } from './storage';
import type { WalletPayload, Account } from '../types/extention';

export class WalletService {
  static async create(password: string): Promise<{ address: string; mnemonic: string }> {
    console.log('WalletService: creating...');
    const mnemonic = generateMnemonic(english);
    console.log('WalletService: generated mnemonic');
    const account = mnemonicToAccount(mnemonic, { accountIndex: 0 });
    console.log('WalletService: derived account');
    const pk = account.getHdKey().privateKey;
    if (!pk) throw new Error('Failed to generate private key');
    
    const accObj: Account = {
      address: account.address,
      name: 'Account 1',
      type: 'mnemonic',
      index: 0,
      privateKey: toHex(pk)
    };
    
    const payload: WalletPayload = {
      mnemonic,
      accounts: [accObj],
      selectedAddress: account.address,
    };
    
    console.log('WalletService: encrypting...');
    const encrypted = await encryptJson(password, payload);
    console.log('WalletService: storing...');
    await setStoredWallet({ version: 1, payload: encrypted });
    
    // Auto unlock
    const settings = await getSettings();
    await setUnlockedState({
      accounts: payload.accounts,
      selectedAddress: payload.selectedAddress,
      mnemonic: payload.mnemonic,
      expiresAt: Date.now() + settings.autoLockSeconds * 1000,
    });

    console.log('WalletService: done');
    return { address: account.address, mnemonic };
  }

  static async import(password: string, input: { privateKey?: string; mnemonic?: string }): Promise<{ address: string; mnemonic?: string }> {
    let payload: WalletPayload;
    let address: string;

    if (input.privateKey) {
      const pk = normalizeHexPrivateKey(input.privateKey);
      if (!pk) throw new Error('Invalid private key');
      const account = privateKeyToAccount(pk);
      address = account.address;
      
      const accObj: Account = {
        address: account.address,
        name: 'Account 1',
        type: 'imported',
        privateKey: pk
      };
      
      payload = {
        accounts: [accObj],
        selectedAddress: account.address
      };
    } else if (input.mnemonic) {
      const mnemonic = input.mnemonic.trim();
      const account = mnemonicToAccount(mnemonic, { accountIndex: 0 });
      const pk = account.getHdKey().privateKey;
      if (!pk) throw new Error('Failed to generate private key');
      
      address = account.address;
      const accObj: Account = {
        address: account.address,
        name: 'Account 1',
        type: 'mnemonic',
        index: 0,
        privateKey: toHex(pk)
      };
      
      payload = {
        mnemonic,
        accounts: [accObj],
        selectedAddress: account.address
      };
    } else {
      throw new Error('Missing mnemonic or private key');
    }

    const encrypted = await encryptJson(password, payload);
    await setStoredWallet({ version: 1, payload: encrypted });

    const settings = await getSettings();
    await setUnlockedState({
      accounts: payload.accounts,
      selectedAddress: payload.selectedAddress,
      mnemonic: payload.mnemonic,
      expiresAt: Date.now() + settings.autoLockSeconds * 1000,
    });

    return { address, mnemonic: payload.mnemonic };
  }

  static async unlock(password: string): Promise<{ address: string }> {
    const stored = await getStoredWallet();
    if (!stored) throw new Error('Wallet not found');

    let payload: WalletPayload;
    try {
      payload = (await decryptJson(password, stored.payload)) as WalletPayload;
    } catch (e) {
      throw new Error('Invalid password');
    }
    
    // Migration: if accounts is missing (old wallet)
    if (!payload.accounts) {
        const old = payload as any;
        const pk = normalizeHexPrivateKey(old.privateKey);
        const mnemonic = old.mnemonic;
        if (!pk) throw new Error('Invalid private key');
        const account = privateKeyToAccount(pk);
        
        const newPayload: WalletPayload = {
            mnemonic,
            accounts: [{
                address: account.address,
                name: 'Account 1',
                type: mnemonic ? 'mnemonic' : 'imported',
                index: mnemonic ? 0 : undefined,
                privateKey: pk
            }],
            selectedAddress: account.address
        };
        
        // Save migrated
        const encrypted = await encryptJson(password, newPayload);
        await setStoredWallet({ version: 1, payload: encrypted });
        
        Object.assign(payload, newPayload);
    }

    const settings = await getSettings();
    
    // Check if we have a preferred address in settings
    let selectedAddress = payload.selectedAddress;
    if (settings.lastSelectedAddress) {
        const exists = payload.accounts.find(a => a.address.toLowerCase() === settings.lastSelectedAddress?.toLowerCase());
        if (exists) {
            selectedAddress = exists.address;
        }
    }

    await setUnlockedState({
      accounts: payload.accounts,
      selectedAddress: selectedAddress,
      mnemonic: payload.mnemonic,
      // expiresAt: Date.now() + settings.autoLockSeconds * 1000, // Auto-lock disabled
    });

    return { address: selectedAddress };
  }

  static async lock(): Promise<void> {
    await clearUnlockedState();
  }

  static async wipe(): Promise<void> {
    await clearUnlockedState();
    await setStoredWallet(null);
  }

  static async getStatus() {
    const unlocked = await getUnlockedState();
    if (unlocked) {
      return {
        locked: false,
        address: unlocked.selectedAddress,
        accounts: unlocked.accounts.map(a => ({ address: a.address, name: a.name, type: a.type })),
        expiresAt: unlocked.expiresAt,
        hasWallet: true,
      };
    }
    const stored = await getStoredWallet();
    return {
      locked: true,
      hasWallet: !!stored,
      address: null,
      accounts: [],
      expiresAt: null,
    };
  }
  
  static async addAccount(name: string | undefined, password: string, privateKey?: string) {
      const state = await getUnlockedState();
      if (!state) throw new Error('Locked');
      
      // Verify password by attempting to decrypt stored wallet
      const stored = await getStoredWallet();
      if (!stored) throw new Error('No wallet stored');
      let payload: WalletPayload;
      try {
          payload = await decryptJson(password, stored.payload) as WalletPayload;
      } catch (e) {
          throw new Error('Invalid password');
      }

      let newAcc: Account;

      if (privateKey) {
          // Import Private Key
          const pk = normalizeHexPrivateKey(privateKey);
          if (!pk) throw new Error('Invalid private key');
          const account = privateKeyToAccount(pk);
          
          // Check if already exists
          if (payload.accounts.some(a => a.address.toLowerCase() === account.address.toLowerCase())) {
              throw new Error('Account already exists');
          }

          newAcc = {
              address: account.address,
              name: name || `Imported ${payload.accounts.length + 1}`,
              type: 'imported',
              privateKey: pk
          };
      } else {
          // Derive from Mnemonic
          if (!payload.mnemonic) throw new Error('No mnemonic to derive from');
          
          const mnemonicAccounts = payload.accounts.filter(a => a.type === 'mnemonic');
          const nextIndex = mnemonicAccounts.length > 0 ? Math.max(...mnemonicAccounts.map(a => (a.index ?? -1))) + 1 : 0;
          
          const account = mnemonicToAccount(payload.mnemonic, { accountIndex: nextIndex });
          const pk = account.getHdKey().privateKey;
          if (!pk) throw new Error('Error deriving');

          newAcc = {
              address: account.address,
              name: name || `Account ${payload.accounts.length + 1}`,
              type: 'mnemonic',
              index: nextIndex,
              privateKey: toHex(pk)
          };
      }
      
      const newAccounts = [...payload.accounts, newAcc];
      
      await setUnlockedState({
          ...state,
          accounts: newAccounts,
          selectedAddress: newAcc.address,
          mnemonic: payload.mnemonic,
      });
      
      const newPayload: WalletPayload = {
          mnemonic: payload.mnemonic,
          accounts: newAccounts,
          selectedAddress: newAcc.address
      };
      const encrypted = await encryptJson(password, newPayload);
      await setStoredWallet({ version: 1, payload: encrypted });
      
      return { address: newAcc.address };
  }

  static async removeAccount(password: string, address: `0x${string}`): Promise<{ removedAddress: `0x${string}`; nextSelectedAddress: `0x${string}` }> {
    const state = await getUnlockedState();
    if (!state) throw new Error('Locked');

    const stored = await getStoredWallet();
    if (!stored) throw new Error('No wallet stored');

    let payload: WalletPayload;
    try {
      payload = await decryptJson(password, stored.payload) as WalletPayload;
    } catch {
      throw new Error('Invalid password');
    }

    if (!payload.accounts || payload.accounts.length === 0) {
      throw new Error('Account not found');
    }
    if (payload.accounts.length === 1) {
      throw new Error('Cannot remove the last account');
    }

    const targetIndex = payload.accounts.findIndex((account) => account.address.toLowerCase() === address.toLowerCase());
    if (targetIndex < 0) throw new Error('Account not found');

    const nextAccounts = payload.accounts.filter((account) => account.address.toLowerCase() !== address.toLowerCase());
    const nextSelectedAddress = payload.selectedAddress.toLowerCase() === address.toLowerCase()
      ? nextAccounts[Math.min(targetIndex, nextAccounts.length - 1)].address
      : payload.selectedAddress;

    const nextPayload: WalletPayload = {
      mnemonic: payload.mnemonic,
      accounts: nextAccounts,
      selectedAddress: nextSelectedAddress,
    };
    const encrypted = await encryptJson(password, nextPayload);
    await setStoredWallet({ version: 1, payload: encrypted });
    await setUnlockedState({
      ...state,
      accounts: nextAccounts,
      selectedAddress: nextSelectedAddress,
      mnemonic: payload.mnemonic,
    });

    const settings = await getSettings();
    if ((settings.lastSelectedAddress ?? '').toLowerCase() === address.toLowerCase()) {
      await setSettings({
        ...settings,
        lastSelectedAddress: nextSelectedAddress,
      });
    }

    return {
      removedAddress: address,
      nextSelectedAddress,
    };
  }
  
  static async switchAccount(address: string) {
      const state = await getUnlockedState();
      if (!state) throw new Error('Locked');
      
      const exists = state.accounts.find(a => a.address.toLowerCase() === address.toLowerCase());
      if (!exists) throw new Error('Account not found');
      
      await setUnlockedState({
          ...state,
          selectedAddress: exists.address
      });
      
      const settings = await getSettings();
      await setSettings({
          ...settings,
          lastSelectedAddress: exists.address
      });
  }

  static async exportPrivateKey(password: string): Promise<string> {
    const stored = await getStoredWallet();
    if (!stored) throw new Error('Wallet not found');
    let payload: WalletPayload;
    try {
      payload = (await decryptJson(password, stored.payload)) as WalletPayload;
    } catch (e) {
      throw new Error('Invalid password');
    }
    
    // Migration check
    if (!payload.accounts) {
         if ((payload as any).privateKey) return (payload as any).privateKey;
    }
    
    const targetAddress = payload.selectedAddress;
    const acc = payload.accounts?.find(a => a.address === targetAddress);
    if (!acc) throw new Error('Account not found');
    
    return acc.privateKey;
  }

  static async exportAccountPrivateKey(password: string, address: `0x${string}`): Promise<`0x${string}`> {
    const stored = await getStoredWallet();
    if (!stored) throw new Error('Wallet not found');
    let payload: WalletPayload;
    try {
      payload = (await decryptJson(password, stored.payload)) as WalletPayload;
    } catch (e) {
      throw new Error('Invalid password');
    }

    if (!payload.accounts) {
      const pk = (payload as any).privateKey as `0x${string}` | undefined;
      if (!pk) throw new Error('Account not found');
      const acc = privateKeyToAccount(pk);
      if (acc.address.toLowerCase() !== address.toLowerCase()) throw new Error('Account not found');
      return pk;
    }

    const found = payload.accounts.find((a) => a.address.toLowerCase() === address.toLowerCase());
    if (!found) throw new Error('Account not found');
    return found.privateKey;
  }
  
  static async exportMnemonic(password: string): Promise<string> {
    const stored = await getStoredWallet();
    if (!stored) throw new Error('Wallet not found');
    let payload: WalletPayload;
    try {
      payload = (await decryptJson(password, stored.payload)) as WalletPayload;
    } catch (e) {
      throw new Error('Invalid password');
    }
    if (!payload.mnemonic) throw new Error('No mnemonic in this wallet');
    return payload.mnemonic;
  }
  
  static async getSigner(address?: `0x${string}`) {
    const unlocked = await getUnlockedState();
    if (!unlocked) throw new Error('Wallet locked');

    const target = (address ?? unlocked.selectedAddress).toLowerCase();
    const acc = unlocked.accounts.find(a => a.address.toLowerCase() === target);
    if (!acc) throw new Error('Active account not found');
    
    return privateKeyToAccount(acc.privateKey);
  }

  static async updatePassword(oldPassword: string, newPassword: string): Promise<void> {
    const stored = await getStoredWallet();
    if (!stored) throw new Error('Wallet not found');
    let payload: WalletPayload;
    try {
      payload = (await decryptJson(oldPassword, stored.payload)) as WalletPayload;
    } catch (e) {
      throw new Error('Invalid password');
    }
    const encrypted = await encryptJson(newPassword, payload);
    await setStoredWallet({ version: 1, payload: encrypted });
  }
}
