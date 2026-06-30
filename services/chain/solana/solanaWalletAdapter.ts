import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { ChainId } from '@/constants/chains/chainId';
import { decryptJson, encryptJson } from '@/utils/crypto';
import {
  getSettings,
  getStoredSolanaWallet,
  getStoredWallet,
  getUnlockedSolanaState,
  getUnlockedState,
  setStoredSolanaWallet,
  setUnlockedSolanaState,
  clearUnlockedSolanaState,
  type UnlockedSolanaState,
} from '@/services/storage';
import type { MultiChainWalletGroup, MultiChainWalletPayload, UniversalAccount, WalletPayload } from '@/types/extention';
import type { WalletAdapter } from '../types';

type SolanaWalletPayload = MultiChainWalletPayload & {
  wallets: {
    solana?: MultiChainWalletGroup;
  };
};

const HARDENED_OFFSET = 0x80000000;
const SOLANA_ACCOUNT_PATH_PREFIX = [44, 501] as const;
const SOLANA_ACCOUNT_CHANGE = 0;

function decodePrivateKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Invalid private key');
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('Invalid Solana secret key');
    return Uint8Array.from(parsed.map((item) => Number(item)));
  }
  return Uint8Array.from(bs58.decode(trimmed));
}

function createAccountFromKeypair(
  keypair: Keypair,
  name: string,
  type: UniversalAccount['type'] = 'imported',
  index?: number,
): UniversalAccount {
  return {
    chainId: ChainId.SOL,
    address: keypair.publicKey.toBase58(),
    name,
    type,
    index,
    privateKey: bs58.encode(keypair.secretKey),
  };
}

function normalizeMnemonicSourceAccounts(
  payload: Pick<WalletPayload, 'accounts'> & { selectedAddress?: string },
) {
  const mnemonicAccounts = payload.accounts
    .filter((account) => account.type === 'mnemonic')
    .map((account, position) => ({
      evmAddress: account.address,
      index: account.index ?? position,
      name: account.name?.trim() || '',
    }))
    .sort((a, b) => a.index - b.index);

  const deduped: Array<{ evmAddress: string; index: number; name: string }> = [];
  const seen = new Set<number>();
  for (const account of mnemonicAccounts) {
    if (seen.has(account.index)) continue;
    seen.add(account.index);
    deduped.push(account);
  }
  if (deduped.length > 0) {
    return deduped;
  }
  return [{
    evmAddress: payload.selectedAddress ?? '',
    index: 0,
    name: 'Account 1',
  }];
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeUint32BE(value: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, value, false);
  return new Uint8Array(view.buffer);
}

async function hmacSha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key.buffer as BufferSource,
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data.buffer as BufferSource);
  return new Uint8Array(signature);
}

async function mnemonicToSeedBytes(mnemonic: string, passphrase = ''): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const normalizedMnemonic = mnemonic.trim().normalize('NFKD');
  const normalizedSalt = `mnemonic${passphrase}`.normalize('NFKD');
  const mnemonicBytes = encoder.encode(normalizedMnemonic);
  const saltBytes = encoder.encode(normalizedSalt);
  const baseKey = await crypto.subtle.importKey(
    'raw',
    mnemonicBytes.buffer as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-512',
      salt: saltBytes.buffer as BufferSource,
      iterations: 2048,
    },
    baseKey,
    512,
  );
  return new Uint8Array(bits);
}

async function deriveSolanaKeypairFromMnemonic(mnemonic: string, index: number): Promise<Keypair> {
  const seed = await mnemonicToSeedBytes(mnemonic);
  let node = await hmacSha512(new TextEncoder().encode('ed25519 seed'), seed);
  let key = node.slice(0, 32);
  let chainCode = node.slice(32, 64);
  const segments = [
    ...SOLANA_ACCOUNT_PATH_PREFIX,
    index,
    SOLANA_ACCOUNT_CHANGE,
  ];

  for (const segment of segments) {
    const hardened = (segment + HARDENED_OFFSET) >>> 0;
    const data = concatBytes(new Uint8Array([0]), key, encodeUint32BE(hardened));
    node = await hmacSha512(chainCode, data);
    key = node.slice(0, 32);
    chainCode = node.slice(32, 64);
  }

  return Keypair.fromSeed(key);
}

async function buildGroupFromMnemonic(
  payload: Pick<WalletPayload, 'mnemonic' | 'accounts'> & { selectedAddress?: string },
): Promise<MultiChainWalletGroup> {
  if (!payload.mnemonic?.trim()) {
    throw new Error('No mnemonic to derive from');
  }
  const sourceAccounts = normalizeMnemonicSourceAccounts(payload);
  const derivedAccounts = await Promise.all(sourceAccounts.map(async (source, position) => {
    const keypair = await deriveSolanaKeypairFromMnemonic(payload.mnemonic!, source.index);
    return createAccountFromKeypair(
      keypair,
      source.name || `Solana Account ${position + 1}`,
      'mnemonic',
      source.index,
    );
  }));

  const selectedIndex = sourceAccounts.find((source) => source.evmAddress.toLowerCase() === (payload.selectedAddress ?? '').toLowerCase())?.index;
  const selectedAddress = derivedAccounts.find((account) => account.index === selectedIndex)?.address ?? derivedAccounts[0]?.address;
  return {
    kind: 'solana',
    mnemonic: payload.mnemonic,
    accounts: derivedAccounts,
    selectedAddress,
  };
}

async function readOwnPayload(password: string): Promise<SolanaWalletPayload | null> {
  const stored = await getStoredSolanaWallet();
  if (!stored) return null;
  try {
    return await decryptJson(password, stored.payload) as SolanaWalletPayload;
  } catch {
    throw new Error('Invalid password');
  }
}

async function readPayload(password: string): Promise<SolanaWalletPayload> {
  const ownPayload = await readOwnPayload(password);
  if (ownPayload) {
    return ownPayload;
  }

  const stored = await getStoredWallet();
  if (!stored) throw new Error('Wallet not found');

  let evmPayload: WalletPayload;
  try {
    evmPayload = await decryptJson(password, stored.payload) as WalletPayload;
  } catch {
    throw new Error('Invalid password');
  }
  if (!evmPayload.mnemonic?.trim()) {
    throw new Error('Solana wallet not found');
  }

  const group = await buildGroupFromMnemonic(evmPayload);
  return {
    version: 2,
    activeChainId: ChainId.SOL,
    wallets: {
      solana: group,
    },
  };
}

function getSolanaGroup(payload: SolanaWalletPayload): MultiChainWalletGroup {
  const group = payload.wallets?.solana;
  if (!group || !Array.isArray(group.accounts) || group.accounts.length === 0) {
    throw new Error('Solana wallet not found');
  }
  return group;
}

async function persistUnlocked(group: MultiChainWalletGroup, expiresAt?: number) {
  const settings = expiresAt === undefined ? await getSettings() : null;
  const unlocked: UnlockedSolanaState = {
    kind: 'solana',
    accounts: group.accounts,
    selectedAddress: group.selectedAddress ?? group.accounts[0]?.address,
    expiresAt: expiresAt ?? (settings ? Date.now() + settings.autoLockSeconds * 1000 : undefined),
  };
  await setUnlockedSolanaState(unlocked);
}

async function persistPayload(password: string, group: MultiChainWalletGroup) {
  const payload: SolanaWalletPayload = {
    version: 2,
    activeChainId: ChainId.SOL,
    wallets: {
      solana: group,
    },
  };
  const encrypted = await encryptJson(password, payload);
  await setStoredSolanaWallet({ version: 2, payload: encrypted });
}

async function getFallbackUnlockedState(): Promise<UnlockedSolanaState | null> {
  const evmUnlocked = await getUnlockedState();
  if (!evmUnlocked?.mnemonic?.trim()) {
    return null;
  }
  const group = await buildGroupFromMnemonic({
    mnemonic: evmUnlocked.mnemonic,
    accounts: evmUnlocked.accounts,
    selectedAddress: evmUnlocked.selectedAddress,
  });
  await persistUnlocked(group, evmUnlocked.expiresAt);
  return await getUnlockedSolanaState();
}

export class SolanaWalletAdapter implements WalletAdapter {
  async getStatus() {
    const unlocked = await getUnlockedSolanaState() ?? await getFallbackUnlockedState();
    if (unlocked) {
      return {
        locked: false,
        address: unlocked.selectedAddress ?? null,
        accounts: unlocked.accounts.map((account) => ({ address: account.address, name: account.name, type: account.type })),
        expiresAt: unlocked.expiresAt,
        hasWallet: true,
      };
    }
    const [stored, fallbackStored] = await Promise.all([
      getStoredSolanaWallet(),
      getStoredWallet(),
    ]);
    return {
      locked: true,
      hasWallet: !!stored || !!fallbackStored,
      address: null,
      accounts: [],
      expiresAt: null,
    };
  }

  async create(password: string) {
    const keypair = Keypair.generate();
    const account = createAccountFromKeypair(keypair, 'Solana Account 1');
    const group: MultiChainWalletGroup = {
      kind: 'solana',
      accounts: [account],
      selectedAddress: account.address,
    };
    await persistPayload(password, group);
    await persistUnlocked(group);
    return { address: account.address, mnemonic: undefined };
  }

  async importWallet(password: string, input: { privateKey?: string; mnemonic?: string }) {
    if (input.mnemonic?.trim()) {
      const group = await buildGroupFromMnemonic({
        mnemonic: input.mnemonic.trim(),
        accounts: [],
        selectedAddress: '',
      });
      await persistPayload(password, group);
      await persistUnlocked(group);
      return { address: group.selectedAddress ?? group.accounts[0].address, mnemonic: input.mnemonic.trim() };
    }
    if (!input.privateKey?.trim()) {
      throw new Error('Missing private key');
    }
    const keypair = Keypair.fromSecretKey(decodePrivateKey(input.privateKey));
    const account = createAccountFromKeypair(keypair, 'Solana Account 1');
    const group: MultiChainWalletGroup = {
      kind: 'solana',
      accounts: [account],
      selectedAddress: account.address,
    };
    await persistPayload(password, group);
    await persistUnlocked(group);
    return { address: account.address, mnemonic: undefined };
  }

  async unlock(password: string) {
    const payload = await readPayload(password);
    const group = getSolanaGroup(payload);
    await persistUnlocked(group);
    return { address: group.selectedAddress ?? group.accounts[0].address };
  }

  async lock() {
    await clearUnlockedSolanaState();
  }

  async wipe() {
    await clearUnlockedSolanaState();
    await setStoredSolanaWallet(null);
  }

  async addAccount(name: string | undefined, password: string, privateKey?: string) {
    const payload = await readPayload(password);
    const group = getSolanaGroup(payload);
    let nextAccount: UniversalAccount;

    if (privateKey?.trim()) {
      const keypair = Keypair.fromSecretKey(decodePrivateKey(privateKey));
      const nextAddress = keypair.publicKey.toBase58();
      if (group.accounts.some((account) => account.address === nextAddress)) {
        throw new Error('Account already exists');
      }
      nextAccount = createAccountFromKeypair(keypair, name?.trim() || `Solana Account ${group.accounts.length + 1}`);
    } else {
      if (!group.mnemonic?.trim()) {
        throw new Error('Solana addAccount currently requires private key import');
      }
      const mnemonicAccounts = group.accounts.filter((account) => account.type === 'mnemonic');
      const nextIndex = mnemonicAccounts.length > 0
        ? Math.max(...mnemonicAccounts.map((account) => account.index ?? -1)) + 1
        : 0;
      const keypair = await deriveSolanaKeypairFromMnemonic(group.mnemonic, nextIndex);
      nextAccount = createAccountFromKeypair(
        keypair,
        name?.trim() || `Solana Account ${group.accounts.length + 1}`,
        'mnemonic',
        nextIndex,
      );
    }

    const nextGroup: MultiChainWalletGroup = {
      ...group,
      accounts: [...group.accounts, nextAccount],
      selectedAddress: nextAccount.address,
    };
    await persistPayload(password, nextGroup);
    await persistUnlocked(nextGroup);
    return { address: nextAccount.address };
  }

  async removeAccount(password: string, address: string) {
    const payload = await readPayload(password);
    const group = getSolanaGroup(payload);
    if (group.accounts.length === 1) {
      throw new Error('Cannot remove the last account');
    }
    const targetIndex = group.accounts.findIndex((account) => account.address === address);
    if (targetIndex < 0) throw new Error('Account not found');

    const nextAccounts = group.accounts.filter((account) => account.address !== address);
    const nextSelectedAddress = (group.selectedAddress ?? group.accounts[0].address) === address
      ? nextAccounts[Math.min(targetIndex, nextAccounts.length - 1)].address
      : (group.selectedAddress ?? group.accounts[0].address);
    const nextGroup: MultiChainWalletGroup = {
      ...group,
      accounts: nextAccounts,
      selectedAddress: nextSelectedAddress,
    };
    await persistPayload(password, nextGroup);
    await persistUnlocked(nextGroup);
    return {
      removedAddress: address,
      nextSelectedAddress,
    };
  }

  async switchAccount(address: string) {
    const unlocked = await getUnlockedSolanaState() ?? await getFallbackUnlockedState();
    if (!unlocked) throw new Error('Locked');
    const exists = unlocked.accounts.find((account) => account.address === address);
    if (!exists) throw new Error('Account not found');
    await setUnlockedSolanaState({
      ...unlocked,
      selectedAddress: exists.address,
    });
  }

  async updatePassword(oldPassword: string, newPassword: string) {
    const ownPayload = await readOwnPayload(oldPassword);
    if (!ownPayload) {
      const payload = await readPayload(oldPassword);
      const group = getSolanaGroup(payload);
      await persistPayload(newPassword, group);
      return;
    }
    const encrypted = await encryptJson(newPassword, ownPayload);
    await setStoredSolanaWallet({ version: 2, payload: encrypted });
  }

  async exportPrivateKey(password: string) {
    const payload = await readPayload(password);
    const group = getSolanaGroup(payload);
    const selectedAddress = group.selectedAddress ?? group.accounts[0].address;
    const account = group.accounts.find((item) => item.address === selectedAddress);
    if (!account?.privateKey) throw new Error('Account not found');
    return account.privateKey;
  }

  async exportAccountPrivateKey(password: string, address: string) {
    const payload = await readPayload(password);
    const group = getSolanaGroup(payload);
    const account = group.accounts.find((item) => item.address === address);
    if (!account?.privateKey) throw new Error('Account not found');
    return account.privateKey;
  }

  async exportMnemonic(_password: string): Promise<string> {
    const payload = await readPayload(_password);
    const group = getSolanaGroup(payload);
    if (!group.mnemonic?.trim()) throw new Error('No mnemonic in this wallet');
    return group.mnemonic;
  }

  async getSigner(address?: string) {
    const unlocked = await getUnlockedSolanaState() ?? await getFallbackUnlockedState();
    if (!unlocked) throw new Error('Wallet locked');
    const target = address ?? unlocked.selectedAddress ?? unlocked.accounts[0]?.address;
    const account = unlocked.accounts.find((item) => item.address === target);
    if (!account?.privateKey) throw new Error('Active account not found');
    return Keypair.fromSecretKey(decodePrivateKey(account.privateKey));
  }
}

export const solanaWalletAdapter = new SolanaWalletAdapter();
