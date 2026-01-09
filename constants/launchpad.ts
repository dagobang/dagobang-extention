import { ChainId } from "./chains";

export const SUPPORTED_LAUNCHPADS: Partial<Record<ChainId, string[]>> = ({
    [ChainId.BNB]: ["fourmeme", "bn_fourmeme", "flap"],
});

export function getSupportedLaunchpads(chainId: ChainId): readonly string[] {
    return SUPPORTED_LAUNCHPADS[chainId] ?? []
}

export function getAxiomLaunchpad(data: any): string {
    switch (data.protocol) {
        case "Fourmeme":
        case "Fourmeme V2":
            return "fourmeme";
        case "Binance":
            return "bn_fourmeme";
        case "Pancakeswap V2":
        case "Pancakeswap V3":
            if (data.extra?.migratedFrom == "Fourmeme V2")
                return "fourmeme";
            return "";
        case "Flap":
            return "flap";
        default:
            return "";
    }
}
