import { ChainId } from "./chains";

export const SUPPORTED_LAUNCHPADS: Partial<Record<ChainId, string[]>> = ({
    [ChainId.BNB]: ["fourmeme", "fourmeme_agent", "bn_fourmeme", "four_xmode_agent", "xmode", "xmode_agent", "flap"],

    [ChainId.ETH]: ["livo", "trench"],
});


export const PLATFORM_OPTIONS = [
    { value: 'fourmeme', label: 'Fourmeme' },
    { value: 'fourmeme_agent', label: 'Fourmeme Agent' },
    { value: 'xmode', label: 'X Mode' },
    { value: 'xmode_agent', label: 'X Mode Agent' },
    { value: 'flap', label: 'Flap' },
] as const;

export const PLATFORM_OPTIONS_ETH = [
    { value: 'livo', label: 'Livo' },
    { value: 'trench', label: 'Trenches' },
] as const;


export function getSupportedLaunchpads(chainId: ChainId): readonly string[] {
    return SUPPORTED_LAUNCHPADS[chainId] ?? []
}

export function normalizeLaunchpadPlatform(value: unknown): string | undefined {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!raw) return undefined;
    if (raw === 'fourmeme' || raw === 'fourmeme v2') return 'fourmeme';
    if (raw === 'fourmeme_agent' || raw === 'fourmeme agent') return 'fourmeme_agent';
    if (raw === 'bn_fourmeme' || raw === 'bn_fourmeme' || raw === 'xmode' || raw === 'x mode') return 'xmode';
    if (raw === 'four_xmode_agent') return 'xmode_agent';
    if (raw === 'flap') return 'flap';
    return raw;
}

export function extractLaunchpadPlatform(input: { launchpadPlatform?: unknown; launchpad_platform?: unknown; platform?: unknown } | null | undefined): string | undefined {
    if (!input) return undefined;
    return normalizeLaunchpadPlatform(input.launchpadPlatform ?? input.launchpad_platform ?? input.platform);
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
