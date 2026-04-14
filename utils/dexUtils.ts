export function getDexPoolPrefer(dex_type: string | undefined): string | undefined {
    if (dex_type?.toLowerCase() === 'PANCAKE_SWAP_V3'.toLowerCase()) {
        return 'v3';
    }
    if (dex_type?.toLowerCase() === 'PANCAKE_SWAP'.toLowerCase()) {
        return 'v2';
    }
    return undefined;
}

export function parseGweiToWei(value: string): bigint {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    const match = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) return 0n;
    const intPart = match[1] || '0';
    const fracPartRaw = match[2] || '';
    const fracPadded = (fracPartRaw + '000000000').slice(0, 9);
    const intBig = BigInt(intPart);
    const fracBig = BigInt(fracPadded);
    return intBig * 1000000000n + fracBig;
}
