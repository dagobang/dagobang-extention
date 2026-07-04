import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import type { RpcResponseAndContext, SignatureStatus } from '@solana/web3.js';
import { ChainId } from '@/constants/chains/chainId';
import { RpcReadBalancer } from '@/services/rpcReadBalancer';
import { SettingsService } from '@/services/settings';
import type { SubmitChannel } from '@/types/extention';

export type SolanaConfirmationCommitment = 'processed' | 'confirmed';

const KNOWN_SOLANA_MINT_META: Record<string, { symbol: string; decimals: number }> = {
  So11111111111111111111111111111111111111112: { symbol: 'WSOL', decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KxuxMxDPZWS9Vyuk3F8F: { symbol: 'USDT', decimals: 6 },
};

const mintProgramIdCache = new Map<string, Promise<PublicKey>>();

export class SolanaRpcService {
  private static connectionCache = new Map<string, Connection>();
  private static balancedConnectionCache = new Map<string, Connection>();

  private static normalizeUrls(urls: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of urls) {
      const url = String(item || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  }

  private static resolveSubmitChannel(chainConfig: any, requested?: SubmitChannel): SubmitChannel {
    if (requested === 'blox' || requested === 'blockrazor' || requested === 'protectRpcs' || requested === 'mixed') return requested;
    const raw = chainConfig?.submitChannel;
    if (raw === 'blox' || raw === 'blockrazor' || raw === 'protectRpcs' || raw === 'mixed') return raw;
    return 'protectRpcs';
  }

  static async getResolvedSubmitChannel(requested?: SubmitChannel): Promise<SubmitChannel> {
    const settings = await SettingsService.get();
    const chainConfig = settings.chains?.[ChainId.SOL];
    return this.resolveSubmitChannel(chainConfig, requested);
  }

  private static getRpcUrlGroups(chainConfig: any): {
    public: string[];
    protectedBase: string[];
    protectedBuy: string[];
    protectedSell: string[];
  } {
    return {
      public: this.normalizeUrls(chainConfig?.rpcUrls ?? []),
      protectedBase: this.normalizeUrls(chainConfig?.protectedRpcUrls ?? []),
      protectedBuy: this.normalizeUrls(chainConfig?.protectedRpcUrlsBuy ?? []),
      protectedSell: this.normalizeUrls(chainConfig?.protectedRpcUrlsSell ?? []),
    };
  }

  private static getProtectedUrlsForSide(chainConfig: any, txSide?: 'buy' | 'sell'): string[] {
    const groups = this.getRpcUrlGroups(chainConfig);
    const sideUrls = txSide === 'buy' ? groups.protectedBuy : txSide === 'sell' ? groups.protectedSell : [];
    return sideUrls.length > 0 ? sideUrls : groups.protectedBase;
  }

  private static getUrlsByScope(
    chainConfig: any,
    txSide: 'buy' | 'sell' | undefined,
    scope: 'protected' | 'public' | 'both',
    opts?: { includeAllProtectedWhenNoSide?: boolean },
  ): string[] {
    const groups = this.getRpcUrlGroups(chainConfig);
    const includeAllProtectedWhenNoSide = !!opts?.includeAllProtectedWhenNoSide;
    const protectedUrls = txSide
      ? this.getProtectedUrlsForSide(chainConfig, txSide)
      : includeAllProtectedWhenNoSide
        ? this.normalizeUrls([...groups.protectedBase, ...groups.protectedBuy, ...groups.protectedSell])
        : groups.protectedBase;
    if (scope === 'protected') return protectedUrls;
    if (scope === 'public') return groups.public;
    return this.normalizeUrls([...protectedUrls, ...groups.public]);
  }

  static async getRpcUrls(): Promise<string[]> {
    const settings = await SettingsService.get();
    const chainConfig = settings.chains?.[ChainId.SOL];
    const urls = this.getUrlsByScope(chainConfig, undefined, 'public');
    if (urls.length > 0) return urls;
    const fallbackUrls = this.getUrlsByScope(chainConfig, undefined, 'both', { includeAllProtectedWhenNoSide: true });
    if (fallbackUrls.length > 0) return fallbackUrls;
    return ['https://api.mainnet-beta.solana.com'];
  }

  static async getSubmitRpcUrls(opts?: {
    txSide?: 'buy' | 'sell';
    submitChannel?: SubmitChannel;
    scope?: 'auto' | 'protected' | 'public' | 'both';
  }): Promise<string[]> {
    const settings = await SettingsService.get();
    const chainConfig = settings.chains?.[ChainId.SOL];
    const submitChannel = this.resolveSubmitChannel(chainConfig, opts?.submitChannel);
    const protectedUrls = this.getUrlsByScope(chainConfig, opts?.txSide, 'protected');
    const publicUrls = this.getUrlsByScope(chainConfig, opts?.txSide, 'public');
    const scope = opts?.scope ?? 'auto';
    if (scope === 'protected') {
      if (protectedUrls.length > 0) return protectedUrls;
      return publicUrls.length > 0 ? publicUrls : ['https://api.mainnet-beta.solana.com'];
    }
    if (scope === 'public') {
      if (publicUrls.length > 0) return publicUrls;
      return protectedUrls.length > 0 ? protectedUrls : ['https://api.mainnet-beta.solana.com'];
    }
    if (scope === 'both') {
      const bothUrls = this.normalizeUrls([...protectedUrls, ...publicUrls]);
      return bothUrls.length > 0 ? bothUrls : ['https://api.mainnet-beta.solana.com'];
    }
    const preferProtected = submitChannel === 'protectRpcs' || submitChannel === 'mixed' || submitChannel === 'blockrazor';
    const urls = preferProtected && protectedUrls.length > 0
      ? protectedUrls
      : publicUrls.length > 0
        ? publicUrls
        : this.normalizeUrls([...protectedUrls, ...publicUrls]);
    if (urls.length > 0) return urls;
    return ['https://api.mainnet-beta.solana.com'];
  }

  static async getConfirmationRpcUrls(opts?: {
    txSide?: 'buy' | 'sell';
    submitChannel?: SubmitChannel;
  }): Promise<string[]> {
    const settings = await SettingsService.get();
    const chainConfig = settings.chains?.[ChainId.SOL];
    const submitChannel = this.resolveSubmitChannel(chainConfig, opts?.submitChannel);
    const allUrls = this.getUrlsByScope(chainConfig, opts?.txSide, 'both', { includeAllProtectedWhenNoSide: true });
    const publicSet = new Set(this.getUrlsByScope(chainConfig, opts?.txSide, 'public'));
    const protectedUrls = allUrls.filter((url) => !publicSet.has(url));
    const publicUrls = allUrls.filter((url) => publicSet.has(url));
    const preferProtectedFirst = submitChannel === 'protectRpcs' || submitChannel === 'mixed' || submitChannel === 'blockrazor';
    const ordered = preferProtectedFirst
      ? this.normalizeUrls([...protectedUrls, ...publicUrls])
      : this.normalizeUrls([...publicUrls, ...protectedUrls]);
    if (ordered.length > 0) return ordered;
    return ['https://api.mainnet-beta.solana.com'];
  }

  static getConnectionForUrl(url: string): Connection {
    const cached = this.connectionCache.get(url);
    if (cached) return cached;
    const connection = new Connection(url, 'confirmed');
    this.connectionCache.set(url, connection);
    return connection;
  }

  static async getConnection(): Promise<Connection> {
    const urls = await this.getRpcUrls();
    const cacheKey = urls.join(',');
    const cached = this.balancedConnectionCache.get(cacheKey);
    if (cached) return cached;
    const primary = this.getConnectionForUrl(urls[0]);
    const proxy = this.createBalancedConnection(urls, primary);
    this.balancedConnectionCache.set(cacheKey, proxy);
    return proxy;
  }

  static async getConnections(): Promise<Array<{ url: string; connection: Connection }>> {
    const urls = await this.getRpcUrls();
    return this.getConnectionsForUrls(urls);
  }

  static getConnectionsForUrls(urls: string[]): Array<{ url: string; connection: Connection }> {
    return urls.map((url) => ({
      url,
      connection: this.getConnectionForUrl(url),
    }));
  }

  private static async measureReadLatency(url: string): Promise<number> {
    const connection = this.getConnectionForUrl(url);
    const startedAt = Date.now();
    await connection.getLatestBlockhash('confirmed');
    return Math.max(1, Date.now() - startedAt);
  }

  private static async executeBalancedRead<T>(input: {
    urls: string[];
    operationName: string;
    operation: (connection: Connection, url: string) => Promise<T>;
  }): Promise<T> {
    const urls = this.normalizeUrls(input.urls);
    if (urls.length <= 0) {
      throw new Error('No Solana RPC URLs configured');
    }
    if (urls.length === 1) {
      const url = urls[0]!;
      const startedAt = Date.now();
      try {
        const result = await input.operation(this.getConnectionForUrl(url), url);
        return result;
      } catch (error: any) {
        const errorMessage = String(error?.message || error || '');
        const errorCode = error?.code ?? error?.cause?.code ?? error?.statusCode ?? error?.response?.status ?? null;
        const httpStatus = error?.statusCode ?? error?.response?.status ?? error?.cause?.status ?? null;
        throw error;
      }
    }
    return await RpcReadBalancer.execute({
      chainId: ChainId.SOL,
      urls,
      probe: async (url) => await this.measureReadLatency(url),
      operation: async (url) => {
        const startedAt = Date.now();
        try {
          const result = await input.operation(this.getConnectionForUrl(url), url);
          return result;
        } catch (error: any) {
          const errorMessage = String(error?.message || error || '');
          const errorCode = error?.code ?? error?.cause?.code ?? error?.statusCode ?? error?.response?.status ?? null;
          const httpStatus = error?.statusCode ?? error?.response?.status ?? error?.cause?.status ?? null;
          throw error;
        }
      },
    });
  }

  private static createBalancedConnection(urls: string[], primary: Connection): Connection {
    const self = this;
    const runBalanced = async <T>(operationName: string, run: (connection: Connection, url: string) => Promise<T>): Promise<T> => {
      return await self.executeBalancedRead({
        urls,
        operationName,
        operation: async (connection, url) => await run(connection, url),
      });
    };

    const overrides: Partial<Record<keyof Connection, any>> = {
      getBalance: async (...args: Parameters<Connection['getBalance']>) =>
        await runBalanced('getBalance', (connection) => connection.getBalance(...args)),
      getAccountInfo: async (...args: Parameters<Connection['getAccountInfo']>) =>
        await runBalanced('getAccountInfo', (connection) => connection.getAccountInfo(...args)),
      getMultipleAccountsInfo: async (...args: Parameters<Connection['getMultipleAccountsInfo']>) =>
        await runBalanced('getMultipleAccountsInfo', (connection) => connection.getMultipleAccountsInfo(...args)),
      getParsedAccountInfo: async (...args: Parameters<Connection['getParsedAccountInfo']>) =>
        await runBalanced('getParsedAccountInfo', (connection) => connection.getParsedAccountInfo(...args)),
      getTokenAccountBalance: async (...args: Parameters<Connection['getTokenAccountBalance']>) =>
        await runBalanced('getTokenAccountBalance', (connection) => connection.getTokenAccountBalance(...args)),
      getLatestBlockhash: async (...args: Parameters<Connection['getLatestBlockhash']>) =>
        await runBalanced('getLatestBlockhash', (connection) => connection.getLatestBlockhash(...args)),
      getLatestBlockhashAndContext: async (...args: Parameters<Connection['getLatestBlockhashAndContext']>) =>
        await runBalanced('getLatestBlockhashAndContext', (connection) => connection.getLatestBlockhashAndContext(...args)),
    };

    return new Proxy(primary, {
      get(target, prop, receiver) {
        if (prop in overrides) {
          return overrides[prop as keyof Connection];
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Connection;
  }

  static toPublicKey(address: string): PublicKey {
    return new PublicKey(address);
  }

  static isValidAddress(address: string): boolean {
    try {
      this.toPublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  static async getNativeBalanceLamports(address: string): Promise<bigint> {
    const connection = await this.getConnection();
    const lamports = await connection.getBalance(this.toPublicKey(address), 'confirmed');
    return BigInt(lamports);
  }

  static async getNativeBalanceSol(address: string): Promise<number> {
    const lamports = await this.getNativeBalanceLamports(address);
    return Number(lamports) / LAMPORTS_PER_SOL;
  }

  static async getSplTokenBalance(ownerAddress: string, mintAddress: string): Promise<bigint> {
    const connection = await this.getConnection();
    const owner = this.toPublicKey(ownerAddress);
    const mint = this.toPublicKey(mintAddress);
    const tokenProgramId = await this.getTokenProgramId(mintAddress);
    const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId);
    const ataBalance = await connection.getTokenAccountBalance(ata, 'confirmed').catch(() => null);
    const amount = (() => {
      const parsed = ataBalance?.value?.amount;
      if (typeof parsed !== 'string' || !parsed) return 0n;
      try {
        return BigInt(parsed);
      } catch {
        return 0n;
      }
    })();
    return amount;
  }

  static async getMintMeta(mintAddress: string): Promise<{ symbol: string; decimals: number }> {
    const known = KNOWN_SOLANA_MINT_META[mintAddress];
    if (known) return known;
    const connection = await this.getConnection();
    const info = await connection.getParsedAccountInfo(this.toPublicKey(mintAddress), 'confirmed');
    const decimals = Number((info.value?.data as any)?.parsed?.info?.decimals);
    return {
      symbol: `${mintAddress.slice(0, 4)}...${mintAddress.slice(-4)}`,
      decimals: Number.isFinite(decimals) && decimals >= 0 ? decimals : 0,
    };
  }

  private static async getTokenProgramId(mintAddress: string): Promise<PublicKey> {
    const key = mintAddress.toLowerCase();
    const cached = mintProgramIdCache.get(key);
    if (cached) return await cached;
    const promise = (async () => {
      const connection = await this.getConnection();
      const mintInfo = await connection.getAccountInfo(this.toPublicKey(mintAddress), 'confirmed');
      const owner = mintInfo?.owner;
      return owner ?? TOKEN_PROGRAM_ID;
    })().catch((error) => {
      mintProgramIdCache.delete(key);
      throw error;
    });
    mintProgramIdCache.set(key, promise);
    return await promise;
  }

  static async sendNativeTransfer(input: {
    signer: Keypair;
    toAddress: string;
    lamports: bigint;
  }): Promise<string> {
    if (input.lamports <= 0n) {
      throw new Error('Invalid amount');
    }
    const connection = await this.getConnection();
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: input.signer.publicKey,
      recentBlockhash: blockhash,
    }).add(SystemProgram.transfer({
      fromPubkey: input.signer.publicKey,
      toPubkey: this.toPublicKey(input.toAddress),
      lamports: Number(input.lamports),
    }));
    transaction.sign(input.signer);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');
    return signature;
  }

  static async confirmSignature(
    signature: string,
    blockhash?: string,
    lastValidBlockHeight?: number,
    timeoutMs = 20_000,
    opts?: {
      commitment?: SolanaConfirmationCommitment;
      pollIntervalMs?: number;
      txSide?: 'buy' | 'sell';
      submitChannel?: SubmitChannel;
    },
  ): Promise<{ confirmationStatus?: string | null; slot?: number; confirmUrl?: string }> {
    const startedAt = Date.now();
    const commitment = opts?.commitment ?? 'confirmed';
    let urls: string[] = [];
    try {
      urls = await this.getConfirmationRpcUrls({
        txSide: opts?.txSide,
        submitChannel: opts?.submitChannel,
      });
      const statusPoll = this.waitForSignature(signature, {
        timeoutMs: Math.max(timeoutMs, 20_000),
        commitment,
        pollIntervalMs: opts?.pollIntervalMs,
        urls,
      });
      void blockhash;
      void lastValidBlockHeight;
      const result = await statusPoll;
      const err = (result as { value?: { err?: unknown } } | null)?.value?.err;
      if (err) {
        throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
      }
      if (Date.now() - startedAt >= Math.max(timeoutMs, 20_000)) {
        return {};
      }
      const normalized = 'context' in (result as any)
        ? { confirmationStatus: commitment }
        : {
          slot: (result as { slot?: number }).slot,
          confirmationStatus: (result as { confirmationStatus?: string | null }).confirmationStatus ?? commitment,
          confirmUrl: (result as { confirmUrl?: string }).confirmUrl,
        };
      await RpcReadBalancer.recordBusinessSuccess({
        chainId: ChainId.SOL,
        url: normalized.confirmUrl ?? null,
        elapsedMs: Date.now() - startedAt,
      });
      return normalized;
    } catch (error: any) {
      throw error;
    }
  }

  static async waitForSignature(
    signature: string,
    opts?: {
      timeoutMs?: number;
      commitment?: SolanaConfirmationCommitment;
      pollIntervalMs?: number;
      urls?: string[];
    },
  ): Promise<{ slot?: number; confirmationStatus?: string | null; confirmUrl?: string }> {
    const timeoutMs = Math.max(opts?.timeoutMs ?? 20_000, 20_000);
    const commitment = opts?.commitment ?? 'confirmed';
    const pollIntervalMs = Math.max(100, Number(opts?.pollIntervalMs ?? (commitment === 'processed' ? 250 : 1000)));
    const urls = opts?.urls?.length ? this.normalizeUrls(opts.urls) : await this.getRpcUrls();
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
      const result = await this.executeBalancedRead<{
        statusResult: RpcResponseAndContext<(SignatureStatus | null)[]>;
        confirmUrl: string;
      }>({
        urls,
        operationName: 'getSignatureStatuses',
        operation: async (connection, url) => ({
          statusResult: await connection.getSignatureStatuses([signature], {
            searchTransactionHistory: true,
          }),
          confirmUrl: url,
        }),
      });
      const status = result.statusResult.value[0];
      if (status) {
        if (status.err) {
          throw new Error(typeof status.err === 'string' ? status.err : JSON.stringify(status.err));
        }
        const current = status.confirmationStatus;
        const reached = commitment === 'processed'
          ? current === 'processed' || current === 'confirmed' || current === 'finalized'
          : current === 'confirmed' || current === 'finalized';
        if (reached) {
          return {
            slot: status.slot,
            confirmationStatus: current,
            confirmUrl: result.confirmUrl,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error('Timed out waiting for Solana transaction confirmation');
  }

  static async sendSplTokenTransfer(input: {
    signer: Keypair;
    mintAddress: string;
    toAddress: string;
    amountRaw: bigint;
    decimals: number;
  }): Promise<string> {
    if (input.amountRaw <= 0n) {
      throw new Error('Invalid amount');
    }
    const connection = await this.getConnection();
    const tokenProgramId = await this.getTokenProgramId(input.mintAddress);
    const mint = this.toPublicKey(input.mintAddress);
    const owner = input.signer.publicKey;
    const receiver = this.toPublicKey(input.toAddress);
    const fromAta = getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId);
    const toAta = getAssociatedTokenAddressSync(mint, receiver, false, tokenProgramId);
    const instructions = [];
    const fromAtaInfo = await connection.getAccountInfo(fromAta, 'confirmed');
    if (!fromAtaInfo) {
      throw new Error('Source token account not found');
    }
    const toAtaInfo = await connection.getAccountInfo(toAta, 'confirmed');
    if (!toAtaInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          owner,
          toAta,
          receiver,
          mint,
          tokenProgramId,
        ),
      );
    }
    instructions.push(
      createTransferCheckedInstruction(
        fromAta,
        mint,
        toAta,
        owner,
        BigInt(input.amountRaw),
        input.decimals,
        [],
        tokenProgramId,
      ),
    );
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: owner,
      recentBlockhash: blockhash,
    });
    for (const instruction of instructions) transaction.add(instruction);
    transaction.sign(input.signer);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.waitForSignature(signature, {
      timeoutMs: 20_000,
      commitment: 'confirmed',
    });
    return signature;
  }
}
