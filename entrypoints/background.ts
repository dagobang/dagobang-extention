import { browser } from 'wxt/browser';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { TokenService } from '@/services/token';
import { RpcService } from '@/services/rpc';
import type { BgRequest } from '@/types/extention';
import { TokenFourmemeService } from '@/services/token.fourmeme';
import FourmemeAPI from '@/hooks/FourmemeAPI';
import FlapAPI from '@/hooks/FlapAPI';

export default defineBackground(() => {
  console.log('Dagobang Background Service Started');

  // Keep the service worker alive by listening to events
  browser.runtime.onInstalled.addListener(() => {
    console.log('Extension installed');
  });

  // Helper to broadcast state changes
  const broadcastStateChange = async () => {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          browser.tabs.sendMessage(tab.id, { type: 'bg:stateChanged' }).catch(() => { });
        }
      }
    } catch (e) {
      console.error('Broadcast failed', e);
    }
  };

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const msg = message as BgRequest;
    console.log('Bg received:', msg.type);

    // Return true to indicate async response
    const handle = async () => {
      try {
        switch (msg.type) {
          case 'bg:ping':
            return { ok: true, time: Date.now() };

          case 'bg:openPopup':
            try {
              // @ts-ignore
              await browser.action.openPopup();
              return { ok: true };
            } catch (e) {
              console.error('Failed to open popup:', e);
              return { ok: false, error: 'Not supported' };
            }

          case 'bg:getState': {
            const status = await WalletService.getStatus();
            const settings = await SettingsService.get();
            const ttl = status.expiresAt ? Math.floor((status.expiresAt - Date.now()) / 1000) : null;

            return {
              wallet: {
                hasEncrypted: status.hasWallet,
                isUnlocked: !status.locked,
                address: status.address,
                accounts: status.accounts,
                unlockTtlSeconds: ttl && ttl > 0 ? ttl : null,
              },
              settings,
              network: { chainId: settings.chainId }
            };
          }

          case 'settings:set':
            await SettingsService.update(msg.settings);
            broadcastStateChange();
            return { ok: true };

          case 'settings:setAccountAlias': {
            const current = await SettingsService.get();
            const nextAliases = { ...(current.accountAliases ?? {}) };
            const key = msg.address.toLowerCase();
            const alias = msg.alias.trim();
            if (alias) {
              nextAliases[key] = alias;
            } else {
              delete nextAliases[key];
            }
            await SettingsService.update({ accountAliases: nextAliases });
            broadcastStateChange();
            return { ok: true };
          }

          case 'wallet:create':
            const resCreate = await WalletService.create(msg.input.password);
            broadcastStateChange();
            return { ok: true, ...resCreate };

          case 'wallet:import':
            const resImport = await WalletService.import(msg.input.password, msg.input);
            broadcastStateChange();
            return { ok: true, ...resImport };

          case 'wallet:unlock':
            const resUnlock = await WalletService.unlock(msg.input.password);
            broadcastStateChange();
            return { ok: true, ...resUnlock };

          case 'wallet:lock':
            await WalletService.lock();
            broadcastStateChange();
            return { ok: true };

          case 'wallet:wipe':
            await WalletService.wipe();
            broadcastStateChange();
            return { ok: true };

          case 'wallet:addAccount':
            const resAdd = await WalletService.addAccount(msg.name, msg.password, msg.privateKey);
            broadcastStateChange();
            return { ok: true, ...resAdd };

          case 'wallet:switchAccount':
            await WalletService.switchAccount(msg.address);
            broadcastStateChange();
            return { ok: true };

          case 'wallet:updatePassword':
            await WalletService.updatePassword(msg.oldPassword, msg.newPassword);
            broadcastStateChange();
            return { ok: true };

          case 'wallet:exportPrivateKey':
            return { ok: true, privateKey: await WalletService.exportPrivateKey(msg.password) };

          case 'wallet:exportAccountPrivateKey':
            return { ok: true, privateKey: await WalletService.exportAccountPrivateKey(msg.password, msg.address) };

          case 'wallet:exportMnemonic':
            return { ok: true, mnemonic: await WalletService.exportMnemonic(msg.password) };

          case 'chain:getBalance':
            return { ok: true, balanceWei: await TokenService.getNativeBalance(msg.address) };

          case 'token:getMeta':
            return { ok: true, ...(await TokenService.getMeta(msg.tokenAddress)) };

          case 'token:getBalance':
            return { ok: true, balanceWei: await TokenService.getBalance(msg.tokenAddress, msg.address) };

          case 'token:getPoolPair': {
            const { token0, token1 } = await TokenService.getPoolPair(msg.pair);
            return { ok: true, token0, token1 };
          }

          case 'token:getTokenInfo:fourmeme':
            return { ok: true, ...(await TokenFourmemeService.getTokenInfo(msg.chainId, msg.tokenAddress)) };

          case 'token:getTokenInfo:fourmemeHttp': {
            const tokenInfo = await FourmemeAPI.getTokenInfo(msg.chain, msg.address);
            return { ok: true, tokenInfo };
          }

          case 'token:getTokenInfo:flapHttp': {
            const tokenInfo = await FlapAPI.getTokenInfo(msg.chain, msg.address);
            return { ok: true, tokenInfo };
          }

          case 'tx:buy': {
            const t1 = Date.now();
            const rsp = await TradeService.buy(msg.input);
            const t2 = Date.now();
            console.log(`Buy transaction ${rsp.txHash} took ${t2 - t1}ms`);
            broadcastStateChange();
            return { ok: true, ...rsp };
          }

          case 'tx:sell': {
            const txHash = await TradeService.sell(msg.input);
            broadcastStateChange();
            return { ok: true, txHash };
          }

          case 'tx:approve': {
            const txHash = await TradeService.approve(msg.chainId, msg.tokenAddress, msg.spender, msg.amountWei);
            broadcastStateChange();
            return { ok: true, txHash };
          }

          case 'tx:approveMaxForSellIfNeeded': {
            const txHash = await TradeService.approveMaxForSellIfNeeded(msg.chainId, msg.tokenAddress, msg.tokenInfo);
            broadcastStateChange();
            return txHash ? { ok: true, txHash } : { ok: true };
          }

          case 'tx:waitForReceipt': {
            const client = await RpcService.getClient();
            const receipt = await client.waitForTransactionReceipt({ hash: msg.hash });
            broadcastStateChange();
            return {
              ok: receipt.status === 'success', 
              blockNumber: Number(receipt.blockNumber),
              txHash: receipt.transactionHash,
              status: receipt.status
            };
          }
        }
      } catch (e: any) {
        console.error('Handler error:', e);
        throw e;
      }
    };

    handle().then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  });
});
