import { SettingsService } from '../settings';
import { getChainRuntime } from '@/constants/chains';

export class BloxRouterAPI {
  private static readonly BASE_URL_HTTPS = "https://api.blxrbdn.com";
  private static readonly PROBE_CACHE_TTL_MS = 30_000;
  private static probeCache:
    | { authHeader: string; checkedAt: number; reachable: boolean; httpStatus?: number; message?: string }
    | null = null;

  private static normalizeAuthHeader(value: unknown): string {
    return typeof value === "string" ? value.replace(/[\r\n]+/g, "").trim() : "";
  }

  private static async getAuthHeader(): Promise<string> {
    const settings = await SettingsService.get();
    const header = this.normalizeAuthHeader((settings as any).bloxrouteAuthHeader);
    if (!header) {
      throw new Error("Bloxroute auth header not configured");
    }
    return header;
  }

  static async probeReachability(opts?: { timeoutMs?: number; force?: boolean }): Promise<{
    reachable: boolean;
    httpStatus?: number;
    message?: string;
    hasAuthHeader: boolean;
  }> {
    const settings = await SettingsService.get();
    const authHeader = this.normalizeAuthHeader((settings as any).bloxrouteAuthHeader);
    const hasAuthHeader = !!authHeader;
    if (!hasAuthHeader) {
      return {
        reachable: false,
        hasAuthHeader: false,
        message: "Bloxroute auth header not configured",
      };
    }

    const now = Date.now();
    if (
      !opts?.force &&
      this.probeCache &&
      this.probeCache.authHeader === authHeader &&
      now - this.probeCache.checkedAt < this.PROBE_CACHE_TTL_MS
    ) {
      return {
        reachable: this.probeCache.reachable,
        httpStatus: this.probeCache.httpStatus,
        message: this.probeCache.message,
        hasAuthHeader: true,
      };
    }

    const timeoutMs = Math.max(200, Number(opts?.timeoutMs ?? 1200));
    try {
      const response = (await Promise.race([
        fetch(this.BASE_URL_HTTPS, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: "{}",
        }),
        new Promise((_, reject) => {
          const id = setTimeout(() => {
            clearTimeout(id);
            reject(new Error("Bloxroute probe timeout"));
          }, timeoutMs);
        }),
      ])) as Response;
      this.probeCache = {
        authHeader,
        checkedAt: now,
        reachable: true,
        httpStatus: response.status,
      };
      return { reachable: true, httpStatus: response.status, hasAuthHeader: true };
    } catch (e: any) {
      const message = String(e?.message || e || "");
      this.probeCache = {
        authHeader,
        checkedAt: now,
        reachable: false,
        message,
      };
      return { reachable: false, message, hasAuthHeader: true };
    }
  }

  private static async post(body: any): Promise<any> {
    const authHeader = await this.getAuthHeader();
    let response: Response;
    try {
      response = await fetch(this.BASE_URL_HTTPS, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new Error(`Bloxroute request failed: ${e.message}`, e);
    }

    const json: any = await response.json().catch((ex) => {
      console.error("Error parsing Bloxroute response:", ex);
      return null;
    });
    if (json?.error) {
      throw new Error(String(json?.error?.message || 'bloxroute rpc error'));
    }
    return json;
  }

  static async sendPrivateTx(chainId: number, signedTx: string): Promise<`0x${string}` | null> {
    const rawTx = signedTx.startsWith("0x") ? signedTx.slice(2) : signedTx;
    const runtime = getChainRuntime(chainId);
    const method = runtime.bloxroutePrivateTxMethod || 'eth_private_tx';
    const json = await this.post({
      jsonrpc: "2.0",
      id: "1",
      method,
      params: {
        transaction: rawTx,
        mev_builders: ["all"],
      },
    });
    let hash = json?.result?.txHash as `0x${string}`;
    if (!hash) {
      throw new Error("Bloxroute did not return tx hash");
    }
    return hash.startsWith("0x") ? hash : `0x${hash}`;
  }

  static async sendBundle(chainId: number, signedTxs: string[]): Promise<`0x${string}`> {
    if (!Array.isArray(signedTxs) || signedTxs.length === 0) {
      throw new Error('Bloxroute bundle txs is empty');
    }
    const txs = signedTxs.map((tx) => {
      const v = typeof tx === 'string' ? tx.trim() : '';
      if (!v) throw new Error('Invalid bundle tx');
      return v.startsWith('0x') ? v.slice(2) : v;
    });
    const runtime = getChainRuntime(chainId);
    const json = await this.post({
      jsonrpc: "2.0",
      id: "1",
      method: "blxr_submit_bundle",
      params: {
        txs,
        blockchain_network: runtime.bloxrouteNetwork || 'Mainnet',
        mev_builders: { all: "" },
      },
    });
    const bundleHash = json?.result?.bundleHash as `0x${string}`;
    if (!bundleHash) throw new Error('Bloxroute did not return bundle hash');
    console.log('Bloxroute bundle hash:', bundleHash);
    return bundleHash;
  }

  static async sendBscPrivateTx(signedTx: string): Promise<`0x${string}` | null> {
    return this.sendPrivateTx(56, signedTx);
  }

  static async sendBscBundle(signedTxs: string[]): Promise<`0x${string}`> {
    return this.sendBundle(56, signedTxs);
  }

  static async prewarm(opts?: { timeoutMs?: number }): Promise<void> {
    await this.probeReachability({ timeoutMs: opts?.timeoutMs }).catch(() => null);
  }
}

export default BloxRouterAPI;
