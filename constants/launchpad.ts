import { ChainId } from "./chains";

export const SUPPORTED_LAUNCHPADS: Partial<Record<ChainId, string[]>> = ({
    [ChainId.BNB]: ["fourmeme", "fourmeme_agent", "bn_fourmeme", "four_xmode_agent", "flap"],
});


export const PLATFORM_OPTIONS = [
    { value: 'fourmeme', label: 'Fourmeme' },
    { value: 'fourmeme_agent', label: 'Fourmeme Agent' },
    { value: 'bn_fourmeme', label: 'X Mode' },
    { value: 'four_xmode_agent', label: 'X Mode Agent' },
    { value: 'flap', label: 'Flap' },
] as const;


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
