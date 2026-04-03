import { SettingsService } from '../settings';

export class BloxRouterAPI {
  private static readonly BASE_URL_HTTPS = "https://api.blxrbdn.com";

  private static async getAuthHeader(): Promise<string> {
    const settings = await SettingsService.get();
    const value = (settings as any).bloxrouteAuthHeader;
    const header = typeof value === "string" ? value.replace(/[\r\n]+/g, "").trim() : "";
    if (!header) {
      throw new Error("Bloxroute auth header not configured");
    }
    return header;
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

  static async sendBscPrivateTx(signedTx: string): Promise<`0x${string}` | null> {
    const rawTx = signedTx.startsWith("0x") ? signedTx.slice(2) : signedTx;
    const json = await this.post({
      jsonrpc: "2.0",
      id: "1",
      method: "bsc_private_tx",
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

  static async sendBscBundle(signedTxs: string[]): Promise<`0x${string}`> {
    if (!Array.isArray(signedTxs) || signedTxs.length === 0) {
      throw new Error('Bloxroute bundle txs is empty');
    }
    const txs = signedTxs.map((tx) => {
      const v = typeof tx === 'string' ? tx.trim() : '';
      if (!v) throw new Error('Invalid bundle tx');
      return v.startsWith('0x') ? v.slice(2) : v;
    });
    const json = await this.post({
      jsonrpc: "2.0",
      id: "1",
      method: "blxr_submit_bundle",
      params: {
        txs,
        blockchain_network: "BSC-Mainnet",
        mev_builders: { all: "" },
      },
    });
    const bundleHash = json?.result?.bundleHash as `0x${string}`;
    if (!bundleHash) throw new Error('Bloxroute did not return bundle hash');
    console.log('Bloxroute bundle hash:', bundleHash);
    return bundleHash;
  }
}

export default BloxRouterAPI;
