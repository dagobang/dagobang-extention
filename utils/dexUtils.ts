export function getDexPoolPrefer(dex_type: string | undefined): string | undefined {
    if (dex_type?.toLowerCase() === 'PANCAKE_SWAP_V3'.toLowerCase()) {
        return 'v3';
    }
    if (dex_type?.toLowerCase() === 'PANCAKE_SWAP'.toLowerCase()) {
        return 'v2';
    }
    return undefined;
}
