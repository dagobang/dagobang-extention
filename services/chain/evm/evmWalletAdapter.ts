import { WalletService } from '@/services/wallet';
import type { WalletAdapter } from '../types';

export class EvmWalletAdapter implements WalletAdapter {
  async getStatus() {
    return await WalletService.getStatus();
  }

  async create(password: string) {
    return await WalletService.create(password);
  }

  async importWallet(password: string, input: { privateKey?: string; mnemonic?: string }) {
    return await WalletService.import(password, input);
  }

  async unlock(password: string) {
    return await WalletService.unlock(password);
  }

  async lock() {
    await WalletService.lock();
  }

  async wipe() {
    await WalletService.wipe();
  }

  async addAccount(name: string | undefined, password: string, privateKey?: string) {
    return await WalletService.addAccount(name, password, privateKey);
  }

  async removeAccount(password: string, address: string) {
    return await WalletService.removeAccount(password, address as `0x${string}`);
  }

  async switchAccount(address: string) {
    await WalletService.switchAccount(address);
  }

  async updatePassword(oldPassword: string, newPassword: string) {
    await WalletService.updatePassword(oldPassword, newPassword);
  }

  async exportPrivateKey(password: string) {
    return await WalletService.exportPrivateKey(password);
  }

  async exportAccountPrivateKey(password: string, address: `0x${string}`) {
    return await WalletService.exportAccountPrivateKey(password, address);
  }

  async exportMnemonic(password: string) {
    return await WalletService.exportMnemonic(password);
  }

  async getSigner(address?: `0x${string}`) {
    return await WalletService.getSigner(address);
  }
}

export const evmWalletAdapter = new EvmWalletAdapter();
