import { SettingsService } from "../services/settings";

export class BloxRouterAPI {
  private static readonly BASE_URL = "https://api.blxrbdn.com";

  private static async getAuthHeader(): Promise<string> {
    const settings = await SettingsService.get();
    const value = (settings as any).bloxrouteAuthHeader;
    const header = typeof value === "string" ? value.trim() : "";
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

    const response = await fetch(this.BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
    });

    const json: any = await response.json().catch(() => null);
    if (typeof json?.result === "string") {
      return json.result as `0x${string}`;
    }
    return null;
  }
}

export default BloxRouterAPI;
