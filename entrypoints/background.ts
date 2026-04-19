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
import { createXSniperTrade } from '@/services/xSniper/xSniperTrade';
import { createTokenSniperTrade } from '@/services/tokenSniper/tokenSniperTrade';
import { createLimitOrderExecutor, tickLimitOrdersForToken } from '@/services/limitOrders/executor';
import type { BgRequest, LimitOrderScanStatus } from '@/types/extention';
import { TokenFourmemeService } from '@/services/token/fourmeme';
import { TokenFlapService } from '@/services/token/flap';
import FourmemeAPI from '@/services/api/fourmeme';
import BloxRouterAPI from '@/services/api/bloxRouter';
import { formatUnits, isAddress, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getGasPriceWei, sendTransaction } from '@/services/trade/tradeTx';
import { classifyBroadcastError, collectErrorText } from '@/utils/txErrorClassify';
import type { TxBuyInput } from '@/types/extention';
import { createTelegramNotifier } from '@/services/telegram/notifier';
import { createTelegramController } from '@/services/telegram/controller';

export default defineBackground(() => {
  console.log('Dagobang Background Service Started');

  browser.action.onClicked.addListener(async (tab) => {
    try {
      const api = (globalThis as any).chrome?.sidePanel;
      const tabId = typeof tab?.id === 'number' ? tab.id : undefined;
      if (api?.open && tabId != null) {
        await api.open({ tabId });
      }
    } catch (e) {
      console.error('Failed to open side panel:', e);
    }
  });

  const broadcastToTabs = async (payload: any) => {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          browser.tabs.sendMessage(tab.id, payload).catch(() => { });
        }
      }
    } catch (e) {
      console.error('Broadcast failed', e);
    }
  };

  const broadcastStateChange = async () => {
    await broadcastToTabs({ type: 'bg:stateChanged' });
  };

  const requestGmgnHoldingsFromContent = async (chain: string, walletAddress: string): Promise<any[]> => {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id) continue;
        try {
          const rsp = await browser.tabs.sendMessage(tab.id, {
            type: 'bg:gmgn:getTokenHoldings',
            chain,
            walletAddress,
          });
          if (rsp?.ok && Array.isArray(rsp?.holdings)) {
            return rsp.holdings;
          }
        } catch {
        }
      }
      return [];
    } catch {
      return [];
    }
  };

  const broadcastTradeSuccess = async (payload: any, tabId?: number | null) => {
    if (typeof tabId === 'number' && tabId > 0) {
      browser.tabs.sendMessage(tabId, payload).catch(() => { });
      return;
    }
    try {
      const activeTabs = await browser.tabs.query({ active: true });
      for (const tab of activeTabs) {
        if (!tab.id) continue;
        browser.tabs.sendMessage(tab.id, payload).catch(() => { });
      }
    } catch {
      broadcastToTabs(payload);
    }
    try {
      if (payload?.type === 'bg:tradeSubmitted') {
        await telegramNotifier.notifyTradeSubmitted({
          source: payload?.source,
          side: payload?.side,
          tokenAddress: payload?.tokenAddress,
          txHash: payload?.txHash,
          submitElapsedMs: payload?.submitElapsedMs,
        });
      } else if (payload?.type === 'bg:tradeSuccess') {
        await telegramNotifier.notifyTradeSuccess({
          source: payload?.source,
          side: payload?.side,
          tokenAddress: payload?.tokenAddress,
          txHash: payload?.txHash,
          submitElapsedMs: payload?.submitElapsedMs,
          receiptElapsedMs: payload?.receiptElapsedMs,
        });
      } else if (payload?.type === 'bg:tradeRetrying') {
        await telegramNotifier.notifyRetrying({
          side: payload?.side,
          tokenAddress: payload?.tokenAddress,
          attempt: payload?.attempt,
          reason: payload?.reason,
        });
      }
    } catch {
    }
  };

  const telegramNotifier = createTelegramNotifier({
    getSettings: SettingsService.get,
  });
  const telegramController = createTelegramController({
    broadcastTradeSuccess: (payload) => broadcastTradeSuccess(payload),
    broadcastStateChange,
    notifier: telegramNotifier,
    fetchGmgnHoldings: requestGmgnHoldingsFromContent,
  });
  telegramController.start();

  let limitOrderScanner: ReturnType<typeof createLimitOrderScanner> | null = null;
  const limitOrderExecutor = createLimitOrderExecutor({
    onOrdersChanged: () => {
      broadcastStateChange();
      limitOrderScanner?.scheduleFromStorage().catch(() => { });
    },
    onOrderTxSubmitted: ({ order, txHash, submitElapsedMs }) => {
      broadcastTradeSuccess({
        type: 'bg:tradeSubmitted',
        source: 'limitOrder',
        id: order.id,
        side: order.side,
        chainId: order.chainId,
        tokenAddress: order.tokenAddress,
        txHash,
        submitElapsedMs,
      });
      void telegramNotifier.notifyLimitOrderResult({
        stage: 'submitted',
        orderId: order.id,
        side: order.side,
        tokenAddress: order.tokenAddress,
        txHash,
      });
    },
    onOrderSubmitted: ({ order, txHash, submitElapsedMs, receiptElapsedMs, totalElapsedMs, broadcastVia, broadcastUrl, isBundle }) => {
      broadcastTradeSuccess({
        type: 'bg:tradeSuccess',
        source: 'limitOrder',
        id: order.id,
        side: order.side,
        chainId: order.chainId,
        tokenAddress: order.tokenAddress,
        txHash,
        submitElapsedMs,
        receiptElapsedMs,
        totalElapsedMs,
        broadcastVia,
        broadcastUrl,
        isBundle,
      });
      void telegramNotifier.notifyLimitOrderResult({
        stage: 'success',
        orderId: order.id,
        side: order.side,
        tokenAddress: order.tokenAddress,
        txHash,
      });
    },
  });
  limitOrderScanner = createLimitOrderScanner({
    executeLimitOrder: limitOrderExecutor.executeLimitOrder,
    onStateChanged: broadcastStateChange,
  });
  limitOrderScanner.start();

  const AutoTrade = createXSniperTrade({ onStateChanged: broadcastStateChange });
  const TokenSniperTrade = createTokenSniperTrade({ onStateChanged: broadcastStateChange });
  const buyInputByTxHash = new Map<`0x${string}`, { input: TxBuyInput; receiptRetried: boolean }>();

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
              const api = (globalThis as any).chrome?.sidePanel;
              const tabId = typeof sender?.tab?.id === 'number' ? sender.tab.id : undefined;
              if (api?.open && tabId != null) {
                await api.open({ tabId });
                return { ok: true };
              }
              return { ok: true };
            } catch (e) {
              console.error('Failed to open side panel:', e);
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

          case 'bloxroute:openCertPage': {
            await browser.tabs.create({ url: 'https://api.blxrbdn.com', active: true });
            return { ok: true };
          }

          case 'bloxroute:probe': {
            const authHeader = typeof msg.authHeader === 'string' ? msg.authHeader.replace(/[\r\n]+/g, '').trim() : '';
            const hasAuthHeader = !!authHeader;
            try {
              const response = await fetch('https://api.blxrbdn.com', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(hasAuthHeader ? { Authorization: authHeader } : {}),
                },
                body: '{}',
              });
              return { ok: true, status: 'reachable', httpStatus: response.status, hasAuthHeader };
            } catch (e: any) {
              return { ok: true, status: 'failed', message: String(e?.message || e || ''), hasAuthHeader };
            }
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

          case 'trade:prewarmTurbo': {
            try {
              await TradeService.prewarmTurbo(msg.input);
            } catch { }
            return { ok: true };
          }

          case 'trade:refreshNonce': {
            try {
              await TradeService.refreshNonce(msg.input);
            } catch { }
            return { ok: true };
          }

          case 'rpc:prewarm': {
            try {
              await RpcService.prewarm(msg.input);
            } catch { }
            return { ok: true };
          }

          case 'tx:transferNative': {
            const settings = await SettingsService.get();
            const chainId = settings.chainId;
            const chainSettings = settings.chains[chainId];

            if (!isAddress(msg.fromAddress)) throw new Error('Invalid from address');
            if (!isAddress(msg.toAddress)) throw new Error('Invalid to address');

            const pk = await WalletService.exportAccountPrivateKey(msg.password, msg.fromAddress);
            const account = privateKeyToAccount(pk);
            if (account.address.toLowerCase() !== msg.fromAddress.toLowerCase()) {
              throw new Error('Invalid from address');
            }

            const client = await RpcService.getClient();
            const gasPreset = chainSettings.sellGasPreset ?? chainSettings.gasPreset;
            const gasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'sell');
            const gasLimit = 21000n;
            const reserve = gasLimit * gasPriceWei;

            const balanceWei = BigInt(await TokenService.getNativeBalance(msg.fromAddress));
            const useMax = !!msg.useMax;
            const valueWei = (() => {
              if (useMax) {
                return balanceWei > reserve ? (balanceWei - reserve) : 0n;
              }
              const raw = typeof msg.amountBnb === 'string' ? msg.amountBnb.trim() : '';
              if (!raw) return 0n;
              try {
                return parseEther(raw);
              } catch {
                return 0n;
              }
            })();

            if (valueWei <= 0n) throw new Error('Invalid amount');
            if (valueWei + reserve > balanceWei) throw new Error('Insufficient balance');

            const { txHash, broadcastVia, broadcastUrl } = await sendTransaction(
              client,
              account,
              msg.toAddress,
              '0x',
              valueWei,
              gasPriceWei,
              chainId,
              { skipEstimateGas: true, gasLimit }
            );
            broadcastStateChange();
            return { ok: true, txHash, broadcastVia, broadcastUrl };
          }

          case 'tx:buy': {
            const isNonceLikeError = (err: any) => {
              const msg = collectErrorText(err, true);
              return classifyBroadcastError(msg) === 'nonce' || msg.includes('nonce');
            };
            const returnBuySuccess = async (rsp: any) => {
              const txHash = (rsp as any)?.txHash as `0x${string}` | undefined;
              if (txHash) {
                buyInputByTxHash.set(txHash, { input: msg.input, receiptRetried: false });
              }
              await broadcastTradeSuccess(
                {
                  type: 'bg:tradeSuccess',
                  source: 'tx:buy',
                  side: 'buy',
                  chainId: msg.input.chainId,
                  tokenAddress: msg.input.tokenAddress,
                  txHash: (rsp as any)?.txHash,
                },
                sender?.tab?.id ?? null,
              );
              await broadcastStateChange();
              return { ok: true, ...rsp };
            };
            try {
              const rsp = await TradeService.buy(msg.input);
              return await returnBuySuccess(rsp);
            } catch (e: any) {
              let lastErr: any = e;
              console.warn('[nonce.repair][buy.submit.failed]', {
                chainId: msg.input.chainId,
                token: msg.input.tokenAddress,
                error: String(e?.shortMessage || e?.message || e || ''),
                nonceLike: isNonceLikeError(e),
              });
              if (isNonceLikeError(e)) {
                try {
                  const refreshedNonce = await TradeService.refreshNonce({ chainId: msg.input.chainId });
                  console.info('[nonce.repair][buy.submit.retry]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    refreshedNonce,
                  });
                  const rsp = await TradeService.buy(msg.input);
                  console.info('[nonce.repair][buy.submit.retry.success]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    txHash: (rsp as any)?.txHash,
                  });
                  return await returnBuySuccess(rsp);
                } catch (ex: any) {
                  lastErr = ex;
                  console.warn('[nonce.repair][buy.submit.retry.failed]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    error: String(ex?.shortMessage || ex?.message || ex || ''),
                  });
                }
              }
              const reason = extractRevertReasonFromError(lastErr);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:buy failed', lastErr, { input: msg.input as any });
              }
              return { ok: false, revertReason: reason ?? undefined, error: serializeTxError(lastErr) };
            }
          }

          case 'tx:buyWithReceiptAuto': {
            const startedAt = Date.now();
            const returnBuySuccess = async (rsp: any) => {
              const txHash = (rsp as any)?.txHash as `0x${string}` | undefined;
              if (txHash) {
                buyInputByTxHash.set(txHash, { input: msg.input, receiptRetried: false });
              }
              await broadcastTradeSuccess(
                {
                  type: 'bg:tradeSuccess',
                  source: 'tx:buy',
                  side: 'buy',
                  chainId: msg.input.chainId,
                  tokenAddress: msg.input.tokenAddress,
                  txHash: (rsp as any)?.txHash,
                },
                sender?.tab?.id ?? null,
              );
              await broadcastStateChange();
              return {
                ok: true,
                ...rsp,
                totalElapsedMs: typeof rsp?.totalElapsedMs === 'number' ? rsp.totalElapsedMs : (Date.now() - startedAt),
              };
            };
            try {
              const rsp = await TradeService.buyWithReceiptAndNonceRecovery(msg.input, {
                maxRetry: 1,
                timeoutMs: 5_000,
                onSubmitted: async (ctx) => {
                  await broadcastTradeSuccess(
                    {
                      type: 'bg:tradeSubmitted',
                      side: 'buy',
                      chainId: msg.input.chainId,
                      tokenAddress: msg.input.tokenAddress,
                      txHash: ctx.txHash,
                      submitElapsedMs: ctx.submitElapsedMs,
                    },
                    sender?.tab?.id ?? null,
                  );
                },
                onRetry: async (ctx) => {
                  await broadcastTradeSuccess(
                    {
                      type: 'bg:tradeRetrying',
                      side: 'buy',
                      chainId: msg.input.chainId,
                      tokenAddress: msg.input.tokenAddress,
                      attempt: ctx.attempt,
                      reason: ctx.reason,
                    },
                    sender?.tab?.id ?? null,
                  );
                },
              });
              return await returnBuySuccess(rsp);
            } catch (e: any) {
              console.warn('[trade.buy.auto.failed]', {
                chainId: msg.input.chainId,
                token: msg.input.tokenAddress,
                error: String(e?.shortMessage || e?.message || e || ''),
              });
              const reason = extractRevertReasonFromError(e);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:buyWithReceiptAuto failed', e, { input: msg.input as any });
              }
              return { ok: false, revertReason: reason ?? undefined, error: serializeTxError(e) };
            }
          }

          case 'tx:sell': {
            const isNonceLikeError = (err: any) => {
              const msg = collectErrorText(err, true);
              return classifyBroadcastError(msg) === 'nonce' || msg.includes('nonce');
            };
            try {
              const rsp = await TradeService.sell(msg.input);
              broadcastTradeSuccess(
                {
                  type: 'bg:tradeSuccess',
                  source: 'tx:sell',
                  side: 'sell',
                  chainId: msg.input.chainId,
                  tokenAddress: msg.input.tokenAddress,
                  txHash: (rsp as any)?.txHash,
                },
                sender?.tab?.id ?? null,
              );
              broadcastStateChange();
              return { ok: true, ...rsp };
            } catch (e: any) {
              let lastErr: any = e;
              console.warn('[nonce.repair][sell.submit.failed]', {
                chainId: msg.input.chainId,
                token: msg.input.tokenAddress,
                error: String(e?.shortMessage || e?.message || e || ''),
                nonceLike: isNonceLikeError(e),
              });
              if (isNonceLikeError(e)) {
                try {
                  const refreshedNonce = await TradeService.refreshNonce({ chainId: msg.input.chainId });
                  console.info('[nonce.repair][sell.submit.retry]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    refreshedNonce,
                  });
                  const rsp = await TradeService.sell(msg.input);
                  console.info('[nonce.repair][sell.submit.retry.success]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    txHash: (rsp as any)?.txHash,
                  });
                  broadcastTradeSuccess(
                    {
                      type: 'bg:tradeSuccess',
                      source: 'tx:sell',
                      side: 'sell',
                      chainId: msg.input.chainId,
                      tokenAddress: msg.input.tokenAddress,
                      txHash: (rsp as any)?.txHash,
                    },
                    sender?.tab?.id ?? null,
                  );
                  broadcastStateChange();
                  return { ok: true, ...rsp };
                } catch (ex: any) {
                  lastErr = ex;
                  console.warn('[nonce.repair][sell.submit.retry.failed]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    error: String(ex?.shortMessage || ex?.message || ex || ''),
                  });
                }
              }
              const reason = extractRevertReasonFromError(lastErr);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:sell failed', lastErr, { input: msg.input as any });
              }
              return { ok: false, revertReason: reason ?? undefined, error: serializeTxError(lastErr) };
            }
          }

          case 'tx:sellWithReceiptAuto': {
            const flowId = `bg-sell-auto:${msg.input.chainId}:${msg.input.tokenAddress.toLowerCase()}:${Date.now().toString(36)}`;
            const start = Date.now();
            console.log('[bg.sell.auto][start]', { flowId, chainId: msg.input.chainId, token: msg.input.tokenAddress });
            try {
              const rsp = await TradeService.sellWithReceiptAndAutoRecovery(msg.input, {
                maxRetry: 1,
                timeoutMs: 8_000,
                onSubmitted: async (ctx) => {
                  await broadcastTradeSuccess(
                    {
                      type: 'bg:tradeSubmitted',
                      side: 'sell',
                      chainId: msg.input.chainId,
                      tokenAddress: msg.input.tokenAddress,
                      txHash: ctx.txHash,
                      submitElapsedMs: ctx.submitElapsedMs,
                    },
                    sender?.tab?.id ?? null,
                  );
                },
                onRetry: async (ctx) => {
                  const reason = ctx.allowanceRepaired ? 'allowance' : (ctx.nonceLike ? 'nonce' : 'other');
                  console.log('[bg.sell.auto][retry]', {
                    flowId,
                    attempt: ctx.attempt,
                    reason,
                    elapsedMs: Date.now() - start,
                  });
                  await broadcastTradeSuccess(
                    {
                      type: 'bg:tradeRetrying',
                      side: 'sell',
                      chainId: msg.input.chainId,
                      tokenAddress: msg.input.tokenAddress,
                      attempt: ctx.attempt,
                      reason,
                    },
                    sender?.tab?.id ?? null,
                  );
                },
              });
              console.log('[bg.sell.auto][success]', {
                flowId,
                txHash: (rsp as any)?.txHash,
                elapsedMs: Date.now() - start,
              });
              broadcastTradeSuccess(
                {
                  type: 'bg:tradeSuccess',
                  source: 'tx:sell',
                  side: 'sell',
                  chainId: msg.input.chainId,
                  tokenAddress: msg.input.tokenAddress,
                  txHash: (rsp as any)?.txHash,
                },
                sender?.tab?.id ?? null,
              );
              broadcastStateChange();
              return {
                ok: true,
                ...rsp,
                totalElapsedMs: typeof rsp?.totalElapsedMs === 'number' ? rsp.totalElapsedMs : (Date.now() - start),
              };
            } catch (e: any) {
              console.warn('[trade.sell.auto.failed]', {
                flowId,
                chainId: msg.input.chainId,
                token: msg.input.tokenAddress,
                elapsedMs: Date.now() - start,
                error: String(e?.shortMessage || e?.message || e || ''),
              });
              const reason = extractRevertReasonFromError(e);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:sellWithReceiptAuto failed', e, { input: msg.input as any });
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

          case 'tx:checkSellAllowanceInsufficient': {
            const check = await TradeService.checkSellAllowanceInsufficient(msg.chainId, msg.tokenAddress, msg.tokenInfo);
            return { ok: true, insufficient: check.insufficient, checked: check.checked };
          }

          case 'tx:bloxroutePrivate': {
            try {
              const txHash = await BloxRouterAPI.sendBscPrivateTx(msg.signedTx);
              return { ok: true, txHash: txHash ?? undefined };
            } catch {
              return { ok: true };
            }
          }

          case 'telegram:test': {
            return await telegramController.test();
          }

          case 'telegram:getStatus': {
            return { ok: true, ...(await telegramController.getStatus()) };
          }

          case 'telegram:quickBuy': {
            return await telegramController.runQuickBuy(msg.tokenAddress, msg.amountBnb);
          }

          case 'telegram:quickSell': {
            return await telegramController.runQuickSell(msg.tokenAddress, msg.sellPercent);
          }

          case 'tx:waitForReceipt': {
            try {
              const receipt = await RpcService.waitForTransactionReceiptAny(msg.hash, { chainId: msg.chainId, timeoutMs: 20_000 });
              const ok = receipt.status === 'success';
              let finalTxHash = receipt.transactionHash;
              let finalStatus = receipt.status;
              let finalBlockNumber = Number(receipt.blockNumber);
              const client = await RpcService.getClient();
              let revertReason = !ok ? await tryGetReceiptRevertReason(client, msg.hash, receipt.blockNumber) : null;

              if (!ok) {
                const tracked = buyInputByTxHash.get(msg.hash);
                const reasonText = String(revertReason || '');
                const isNonceLike = classifyBroadcastError(reasonText.toLowerCase()) === 'nonce' || reasonText.toLowerCase().includes('nonce');
                console.warn('[nonce.repair][buy.receipt.failed]', {
                  chainId: msg.chainId,
                  txHash: msg.hash,
                  tracked: !!tracked,
                  receiptRetried: tracked?.receiptRetried ?? false,
                  isNonceLike,
                  revertReason: reasonText,
                });
                if (tracked && !tracked.receiptRetried && isNonceLike) {
                  tracked.receiptRetried = true;
                  buyInputByTxHash.set(msg.hash, tracked);
                  const refreshedNonce = await TradeService.refreshNonce({ chainId: tracked.input.chainId });
                  console.info('[nonce.repair][buy.receipt.retry]', {
                    chainId: tracked.input.chainId,
                    oldTxHash: msg.hash,
                    refreshedNonce,
                  });
                  const retryRsp = await TradeService.buy(tracked.input);
                  const retryHash = retryRsp.txHash as `0x${string}`;
                  console.info('[nonce.repair][buy.receipt.retry.sent]', {
                    chainId: tracked.input.chainId,
                    oldTxHash: msg.hash,
                    retryHash,
                  });
                  buyInputByTxHash.set(retryHash, { input: tracked.input, receiptRetried: true });
                  const retryReceipt = await RpcService.waitForTransactionReceiptAny(retryHash, { chainId: tracked.input.chainId, timeoutMs: 20_000, txSide: 'buy' });
                  finalTxHash = retryReceipt.transactionHash;
                  finalStatus = retryReceipt.status;
                  finalBlockNumber = Number(retryReceipt.blockNumber);
                  revertReason = retryReceipt.status === 'success'
                    ? null
                    : await tryGetReceiptRevertReason(client, retryHash, retryReceipt.blockNumber);
                }
              }

              if (finalStatus === 'success') {
                buyInputByTxHash.delete(msg.hash);
                buyInputByTxHash.delete(finalTxHash);
              }
              broadcastStateChange();
              return {
                ok: finalStatus === 'success',
                blockNumber: finalBlockNumber,
                txHash: finalTxHash,
                status: finalStatus,
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

          case 'twitter:signal': {
            const signal = msg.payload as any;
            await Promise.all([
              (AutoTrade as any).handleTwitterSignal(signal),
              (TokenSniperTrade as any).handleTwitterSignal(signal),
            ]);
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
