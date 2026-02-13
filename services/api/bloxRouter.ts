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

  static async sendBscPrivateTx(signedTx: string): Promise<`0x${string}` | null> {
    const authHeader = await this.getAuthHeader();
    const rawTx = signedTx.startsWith("0x") ? signedTx.slice(2) : signedTx;
    const body = {
      jsonrpc: "2.0",
      id: "1",
      method: "bsc_private_tx",
      params: {
        transaction: rawTx,
        mev_builders: ["all"],
      },
    };

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
    let hash = json?.result?.txHash as `0x${string}`;
    if (!hash) {
      throw new Error("Bloxroute did not return tx hash");
    }
    return hash.startsWith("0x") ? hash : `0x${hash}`;
  }
}

export default BloxRouterAPI;
