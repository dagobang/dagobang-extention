import { browser } from 'wxt/browser';
import { parseEther } from 'viem';
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

  const recentAutoBuys = new Map<string, number>();
  const autoPositions = new Map<string, {
    chainId: number;
    tokenAddress: `0x${string}`;
    entryPriceUsd: number | null;
    entryTime: number;
    lastPriceUsd: number | null;
  }>();

  const getKey = (chainId: number, tokenAddress: `0x${string}`) => `${chainId}:${tokenAddress.toLowerCase()}`;

  const parseNumber = (v: string | null | undefined) => {
    if (!v) return null;
    const n = Number(v.trim());
    if (!Number.isFinite(n)) return null;
    return n;
  };

  const extractTokenMetrics = (data: any) => {
    if (!data || typeof data !== 'object') return null;
    let obj = data;
    if (obj.data && typeof obj.data === 'object') obj = obj.data;
    const metrics: {
      tokenAddress?: `0x${string}`;
      marketCapUsd?: number;
      liquidityUsd?: number;
      holders?: number;
      createdAtMs?: number;
      devAddress?: `0x${string}`;
      devHoldPercent?: number;
      devHasSold?: boolean;
      priceUsd?: number;
    } = {};
    const visit = (source: any) => {
      if (!source || typeof source !== 'object') return;
      for (const [k, v] of Object.entries(source)) {
        const key = k.toLowerCase();
        if (!metrics.tokenAddress && typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v)) {
          if (key.includes('token') || key.includes('contract') || key === 'ca' || key === 'address') {
            metrics.tokenAddress = v as `0x${string}`;
          }
        }
        if (!metrics.marketCapUsd && typeof v === 'number' && key.includes('market') && key.includes('cap')) {
          metrics.marketCapUsd = v;
        }
        if (!metrics.liquidityUsd && typeof v === 'number' && key.includes('liquidity')) {
          metrics.liquidityUsd = v;
        }
        if (!metrics.holders && typeof v === 'number' && (key.includes('holder') || key.includes('holders'))) {
          metrics.holders = v;
        }
        if (!metrics.priceUsd && typeof v === 'number' && (key === 'price' || key.includes('price_usd'))) {
          metrics.priceUsd = v;
        }
        if (!metrics.createdAtMs && typeof v === 'number' && (key.includes('create_time') || key.includes('launch_time') || key.includes('created_at'))) {
          metrics.createdAtMs = v * (v < 10_000_000_000 ? 1000 : 1);
        }
        if (!metrics.devAddress && typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v) && (key.includes('dev') || key.includes('owner') || key.includes('creator'))) {
          metrics.devAddress = v as `0x${string}`;
        }
        if (!metrics.devHoldPercent && typeof v === 'number' && (key.includes('dev') && key.includes('percent'))) {
          metrics.devHoldPercent = v;
        }
        if (metrics.devHasSold == null && typeof v === 'boolean' && (key.includes('dev') && key.includes('sell'))) {
          metrics.devHasSold = v;
        }
        if (v && typeof v === 'object') {
          visit(v);
        }
      }
    };
    visit(obj);
    if (!metrics.tokenAddress) return null;
    return metrics;
  };

  const shouldBuyByConfig = (metrics: ReturnType<typeof extractTokenMetrics>, config: any) => {
    if (!metrics || !config) return false;
    const maxMcap = parseNumber(config.maxMarketCapUsd);
    if (maxMcap != null && metrics.marketCapUsd != null && metrics.marketCapUsd > maxMcap) return false;
    const minLiq = parseNumber(config.minLiquidityUsd);
    if (minLiq != null && metrics.liquidityUsd != null && metrics.liquidityUsd < minLiq) return false;
    const minHolders = parseNumber(config.minHolders);
    if (minHolders != null && metrics.holders != null && metrics.holders < minHolders) return false;
    const maxAgeMin = parseNumber(config.maxTokenAgeMinutes);
    if (maxAgeMin != null && metrics.createdAtMs != null) {
      const ageMin = (Date.now() - metrics.createdAtMs) / 60000;
      if (ageMin > maxAgeMin) return false;
    }
    const maxDevPct = parseNumber(config.maxDevHoldPercent);
    if (maxDevPct != null && metrics.devHoldPercent != null && metrics.devHoldPercent > maxDevPct) return false;
    if (config.blockIfDevSell && metrics.devHasSold === true) return false;
    return true;
  };

  const handleAutoTradeWebSocket = async (payload: any) => {
    try {
      if (!payload || payload.direction !== 'receive') return;
      const settings = await SettingsService.get();
      const config = (settings as any).autoTrade;
      if (!config || !config.enabled) return;
      const metrics = extractTokenMetrics(payload.data);
      if (!metrics || !metrics.tokenAddress) return;
      if (!shouldBuyByConfig(metrics, config)) return;
      const chainId = settings.chainId;
      const key = getKey(chainId, metrics.tokenAddress);
      const now = Date.now();
      const last = recentAutoBuys.get(key);
      if (last && now - last < 5 * 60 * 1000) return;
      const amountNumber = parseNumber(config.buyAmountBnb) ?? 0;
      if (amountNumber <= 0) return;
      const amountWei = parseEther(String(amountNumber));
      const status = await WalletService.getStatus();
      if (status.locked || !status.address) return;
      const rsp = await TradeService.buy({
        chainId,
        tokenAddress: metrics.tokenAddress,
        bnbAmountWei: amountWei.toString(),
      });
      console.log('AutoTrade buy tx', rsp.txHash);
      recentAutoBuys.set(key, now);
      autoPositions.set(key, {
        chainId,
        tokenAddress: metrics.tokenAddress,
        entryPriceUsd: metrics.priceUsd ?? null,
        entryTime: now,
        lastPriceUsd: metrics.priceUsd ?? null,
      });
      broadcastStateChange();
    } catch (e) {
      console.error('AutoTrade ws handler error', e);
    }
  };

  const handleAutoSellCheck = async (payload: any) => {
    try {
      const settings = await SettingsService.get();
      const config = (settings as any).autoTrade;
      if (!config || !config.autoSellEnabled) return;
      const metrics = extractTokenMetrics(payload.data);
      if (!metrics || !metrics.tokenAddress) return;
      const chainId = settings.chainId;
      const key = getKey(chainId, metrics.tokenAddress);
      const pos = autoPositions.get(key);
      if (!pos) return;
      const now = Date.now();
      const price = metrics.priceUsd ?? pos.lastPriceUsd;
      if (price != null) {
        pos.lastPriceUsd = price;
      }
      const tp = parseNumber(config.takeProfitMultiple);
      const sl = parseNumber(config.stopLossMultiple);
      const maxHoldMin = parseNumber(config.maxHoldMinutes);
      const entryPrice = pos.entryPriceUsd;
      let shouldSell = false;
      if (entryPrice && price) {
        if (tp && tp > 0 && price >= entryPrice * tp) {
          shouldSell = true;
        }
        if (!shouldSell && sl && sl > 0 && price <= entryPrice * sl) {
          shouldSell = true;
        }
      }
      if (!shouldSell && maxHoldMin && maxHoldMin > 0) {
        const ageMin = (now - pos.entryTime) / 60000;
        if (ageMin >= maxHoldMin) {
          shouldSell = true;
        }
      }
      if (!shouldSell) return;
      autoPositions.delete(key);
      const txHash = await TradeService.sell({
        chainId,
        tokenAddress: metrics.tokenAddress,
        tokenAmountWei: '0',
        sellPercentBps: 10000,
      });
      console.log('AutoTrade sell tx', txHash);
      broadcastStateChange();
    } catch (e) {
      console.error('AutoTrade sell handler error', e);
    }
  };

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

        case 'autotrade:ws': {
          await handleAutoTradeWebSocket(msg.payload);
          await handleAutoSellCheck(msg.payload);
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
