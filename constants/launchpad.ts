import { ChainId } from "./chains";

export const SUPPORTED_LAUNCHPADS: Partial<Record<ChainId, string[]>> = ({
    [ChainId.BNB]: ["fourmeme",
        // "fourmeme_agent",
        // "bn_fourmeme",
        //  "four_xmode_agent", "xmode", "xmode_agent",
        "flap", "flap_stocks", "flap_aioracle",
        "printr",
        "openfour", "likwid", "goplus_skills", "goplus_creator", "cubepeg"],

    [ChainId.ETH]: ["livo", "trench"],

    [ChainId.HYPER]: ["altfun", "alt.fun"],
    [ChainId.SOL]: ["pumpfun", "pumpswap", "raydium", "meteora", "bonk", "bags"],
});


export const PLATFORM_OPTIONS = [
    { value: 'fourmeme', label: 'Fourmeme' },
    // { value: 'fourmeme_agent', label: 'Fourmeme Agent' },
    // { value: 'xmode', label: 'X Mode' },
    // { value: 'xmode_agent', label: 'X Mode Agent' },
    { value: 'flap', label: 'Flap' },
    { value: 'flap_stocks', label: 'Flap Stocks' },
    { value: 'flap_aioracle', label: 'Flap AI' },
    { value: 'printr', label: 'Printr' },
    { value: 'openfour', label: 'OpenFour' },
    { value: 'goplus_skills', label: 'GoPlus Skills' },
    { value: 'goplus_creator', label: 'GoPlus Creator' },
    { value: 'likwid', label: 'Likwid' },
    { value: 'cubepeg', label: 'Cubepeg' },
] as const;

export const PLATFORM_OPTIONS_ETH = [
    { value: 'livo', label: 'Livo' },
    { value: 'trench', label: 'Trenches' },
] as const;

export const PLATFORM_OPTIONS_HYPER = [
    { value: 'altfun', label: 'alt.fun' },
] as const;

export const PLATFORM_OPTIONS_SOL = [
    { value: 'pumpfun', label: 'Pump.fun' },
    { value: 'pumpswap', label: 'PumpSwap' },
    { value: 'raydium', label: 'Raydium' },
    { value: 'meteora', label: 'Meteora' },
    { value: 'bonk', label: 'Bonk' },
    { value: 'bags', label: 'Bags' },
] as const;


export function getSupportedLaunchpads(chainId: ChainId): readonly string[] {
    return SUPPORTED_LAUNCHPADS[chainId] ?? []
}

export function getPlatformOptionsByChain(chainId: ChainId) {
    if (chainId === ChainId.SOL) return PLATFORM_OPTIONS_SOL;
    if (chainId === ChainId.HYPER) return PLATFORM_OPTIONS_HYPER;
    if (chainId === ChainId.ETH) return PLATFORM_OPTIONS_ETH;
    return PLATFORM_OPTIONS;
}

export function normalizeLaunchpadPlatform(value: unknown): string | undefined {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!raw) return undefined;
    if (raw === 'fourmeme' || raw === 'fourmeme v2') return 'fourmeme';
    if (raw === 'fourmeme_agent' || raw === 'fourmeme agent') return 'fourmeme_agent';
    if (raw === 'bn_fourmeme' || raw === 'bn_fourmeme' || raw === 'xmode' || raw === 'x mode') return 'xmode';
    if (raw === 'four_xmode_agent') return 'xmode_agent';
    if (raw === 'flap') return 'flap';
    if (raw === 'flap_stocks' || raw === 'flap stocks') return 'flap_stocks';
    if (raw === 'printr') return 'printr';
    if (raw === 'openfour' || raw === 'open four') return 'openfour';
    if (raw === 'likwid') return 'likwid';
    if (raw === 'alt.fun' || raw === 'altfun') return 'altfun';
    if (raw === 'pump' || raw === 'pumpfun' || raw === 'pump.fun') return 'pumpfun';
    if (raw === 'pumpswap' || raw === 'pump_swap' || raw === 'pumpamm' || raw === 'pump amm') return 'pumpswap';
    if (raw === 'raydium') return 'raydium';
    if (raw === 'meteora' || raw === 'dlmm' || raw === 'damm' || raw === 'damm_v2') return 'meteora';
    if (raw === 'bonk') return 'bonk';
    if (raw === 'bags') return 'bags';
    return raw;
}

export function extractLaunchpadPlatform(input: {
    launchpadPlatform?: unknown;
    launchpad_platform?: unknown;
    platform?: unknown;
    lp?: unknown;
    lpp?: unknown;
} | null | undefined): string | undefined {
    if (!input) return undefined;
    return normalizeLaunchpadPlatform(
        input.launchpadPlatform ??
        input.launchpad_platform ??
        input.platform ??
        input.lp ??
        input.lpp
    );
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
