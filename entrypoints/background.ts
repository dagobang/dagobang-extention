import { browser } from 'wxt/browser';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { TokenService } from '@/services/token';
import { RpcService } from '@/services/rpc';
import {
  cancelAllLimitOrders, cancelLimitOrder,
  createLimitOrder,
  listLimitOrders
} from '@/services/limitOrders/store';
import { debugLogTxError, extractRevertReasonFromError, serializeTxError, tryGetReceiptRevertReason } from '@/services/tx/errors';
import { createLimitOrderScanner } from './background/limitOrderScanner';
import { createAutoTrade } from '@/services/autoTrade';
import { createLimitOrderExecutor, tickLimitOrdersForToken } from '@/services/limitOrders/executor';
import type { BgRequest, LimitOrderScanStatus } from '@/types/extention';
import { TokenFourmemeService } from '@/services/token/fourmeme';
import { TokenFlapService } from '@/services/token/flap';
import FourmemeAPI from '@/services/api/fourmeme';
import BloxRouterAPI from '@/services/api/bloxRouter';

export default defineBackground(() => {
  console.log('Dagobang Background Service Started');

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

  let limitOrderScanner: ReturnType<typeof createLimitOrderScanner> | null = null;
  const limitOrderExecutor = createLimitOrderExecutor({
    onOrdersChanged: () => {
      broadcastStateChange();
      limitOrderScanner?.scheduleFromStorage().catch(() => { });
    }
  });
  limitOrderScanner = createLimitOrderScanner({
    executeLimitOrder: limitOrderExecutor.executeLimitOrder,
    onStateChanged: broadcastStateChange,
  });
  limitOrderScanner.start();

  const AutoTrade = createAutoTrade({ onStateChanged: broadcastStateChange });

  browser.runtime.onInstalled.addListener(() => {
    console.log('Extension installed');
  });

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const msg = message as BgRequest;
    if (msg.type === 'chain:getBalance' || msg.type === 'token:getBalance' || msg.type === 'bg:getState') {
      const from = sender?.url || sender?.tab?.url || '';
      const tabId = typeof sender?.tab?.id === 'number' ? sender.tab.id : null;
      const active = sender?.tab ? !!sender.tab.active : null;
      console.log('Bg received:', msg.type, { from, tabId, active });
    } else {
      console.log('Bg received:', msg.type);
    }

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
            limitOrderScanner?.setIntervalMsFromValue((msg.settings as any).limitOrderScanIntervalMs);
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

          case 'token:getPriceUsd': {
            const priceUsd = await TokenService.getTokenPriceUsdFromRpc({
              chainId: msg.chainId,
              tokenAddress: msg.tokenAddress,
              tokenInfo: msg.tokenInfo ?? null,
              cacheTtlMs: 3000,
            });
            return { ok: true, priceUsd };
          }

          case 'token:getTokenInfo:fourmeme':
            return { ok: true, ...(await TokenFourmemeService.getTokenInfo(msg.chainId, msg.tokenAddress)) };

          case 'token:getTokenInfo:flap':
            return { ok: true, ...(await TokenFlapService.getTokenInfo(msg.chainId, msg.tokenAddress)) };

          case 'token:getTokenInfo:fourmemeHttp': {
            const tokenInfo = await FourmemeAPI.getTokenInfo(msg.chain, msg.address);
            return { ok: true, tokenInfo };
          }

          case 'token:createFourmeme': {
            const settings = await SettingsService.get();
            const account = await WalletService.getSigner();
            const address = account.address;
            const networkCode = 'BSC';

            const nonce = await FourmemeAPI.generateNonce(address, networkCode);
            const message = `You are sign in Meme ${nonce}`;
            const signature = await account.signMessage({ message });

            const accessToken = await FourmemeAPI.loginDex({
              address,
              signature,
              networkCode,
              walletName: 'undefined',
            });

            const uploadedImgUrl = await FourmemeAPI.uploadImageFromUrl(msg.input.imgUrl, accessToken);

            const createData = await FourmemeAPI.createToken(
              {
                ...msg.input,
                imgUrl: uploadedImgUrl,
              },
              accessToken
            );

            if (!createData || !createData.createArg || !createData.sign) {
              return { ok: true, data: { api: createData } };
            }

            const onChainResult = await TokenFourmemeService.createTokenOnChain(
              settings.chainId,
              createData.createArg,
              createData.sign
            );

            return {
              ok: true,
              data: {
                api: createData,
                txHash: onChainResult.txHash,
                tokenAddress: onChainResult.tokenAddress,
              },
            };
          }

          case 'ai:generateLogo': {
            const endpoint = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
            const res = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${msg.apiKey}`,
              },
              body: JSON.stringify({
                model: 'doubao-seedream-4-5-251128',
                prompt: msg.prompt,
                size: msg.size || '2K',
                watermark: false,
                response_format: 'url',
              }),
            });
            if (!res.ok) {
              const text = await res.text().catch(() => '');
              throw new Error(text || `Seedream4.5 request failed: ${res.status}`);
            }
            const data: any = await res.json();
            let imageUrl = '';
            if (Array.isArray(data.data) && data.data.length > 0) {
              const item = data.data[0];
              imageUrl = item.url || item.url || '';
            } else if (typeof data.url === 'string') {
              imageUrl = data.url;
            }
            if (!imageUrl) {
              throw new Error('Seedream4.5 response missing image url');
            }
            return { ok: true, imageUrl };
          }

          case 'limitOrder:list': {
            const orders = await listLimitOrders(msg.chainId, msg.tokenAddress);
            return { ok: true, orders };
          }

          case 'limitOrder:create': {
            const order = await createLimitOrder(msg.input);
            broadcastStateChange();
            limitOrderScanner?.scheduleFromStorage().catch(() => { });
            return { ok: true, order };
          }

          case 'limitOrder:cancel': {
            const orders = await cancelLimitOrder(msg.id);
            broadcastStateChange();
            limitOrderScanner?.scheduleFromStorage().catch(() => { });
            return { ok: true, orders };
          }

          case 'limitOrder:cancelAll': {
            const orders = await cancelAllLimitOrders(msg.chainId, msg.tokenAddress);
            broadcastStateChange();
            limitOrderScanner?.scheduleFromStorage().catch(() => { });
            return { ok: true, orders };
          }

          case 'limitOrder:scanStatus': {
            const status = await (limitOrderScanner?.getStatus(msg.chainId) ?? Promise.resolve({
              intervalMs: 3000,
              running: false,
              lastScanAtMs: 0,
              lastScanOk: true,
              lastScanError: null,
              totalOrders: 0,
              openOrders: 0,
              pricesByTokenKey: {},
            } as LimitOrderScanStatus));
            return { ok: true, ...status };
          }

          case 'limitOrder:tick': {
            const res = await tickLimitOrdersForToken({
              chainId: msg.chainId,
              tokenAddress: msg.tokenAddress,
              priceUsd: msg.priceUsd,
              executeLimitOrder: limitOrderExecutor.executeLimitOrder,
            });
            if (res.triggered.length || res.executed.length || res.failed.length) {
              broadcastStateChange();
            }
            return { ok: true, ...res };
          }

          case 'tx:buy': {
            try {
              const t1 = Date.now();
              const rsp = await TradeService.buy(msg.input);
              const t2 = Date.now();
              console.log(`Buy transaction ${rsp.txHash} took ${t2 - t1}ms`);
              broadcastStateChange();
              return { ok: true, ...rsp };
            } catch (e: any) {
              const reason = extractRevertReasonFromError(e);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:buy failed', e, { input: msg.input as any });
              }
              return { ok: false, revertReason: reason ?? undefined, error: serializeTxError(e) };
            }
          }

          case 'tx:sell': {
            try {
              const txHash = await TradeService.sell(msg.input);
              broadcastStateChange();
              return { ok: true, txHash };
            } catch (e: any) {
              const reason = extractRevertReasonFromError(e);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:sell failed', e, { input: msg.input as any });
              }
              return { ok: false, revertReason: reason ?? undefined, error: serializeTxError(e) };
            }
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

          case 'tx:bloxroutePrivate': {
            try {
              const txHash = await BloxRouterAPI.sendBscPrivateTx(msg.signedTx);
              return { ok: true, txHash: txHash ?? undefined };
            } catch {
              return { ok: true };
            }
          }

          case 'tx:waitForReceipt': {
            const client = await RpcService.getClient();
            try {
              const receipt = await client.waitForTransactionReceipt({ hash: msg.hash });
              const ok = receipt.status === 'success';
              const blockNumber = Number(receipt.blockNumber);
              const txHash = receipt.transactionHash;
              const status = receipt.status;
              const revertReason = !ok ? await tryGetReceiptRevertReason(client, msg.hash, receipt.blockNumber) : null;
              broadcastStateChange();
              return {
                ok,
                blockNumber,
                txHash,
                status,
                revertReason: revertReason ?? undefined,
              };
            } catch (e: any) {
              const reason = extractRevertReasonFromError(e);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:waitForReceipt failed', e, { hash: msg.hash, chainId: msg.chainId });
              }
              return { ok: false, txHash: msg.hash, revertReason: reason ?? undefined, error: serializeTxError(e) };
            }
          }

          case 'autotrade:ws': {
            await AutoTrade.handleAutoTradeWebSocket(msg.payload);
            await AutoTrade.handleAutoSellCheck(msg.payload);
            return { ok: true };
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
