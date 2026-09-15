export function getDexPoolPrefer(dex_type: string | undefined): string | undefined {
    const lowered = dex_type?.toLowerCase();
    if (!lowered) return undefined;
    if (lowered.includes('v4') || lowered.includes('infinity')) return 'v4';
    if (lowered === 'pancake_swap_v3' || lowered === 'uniswap_v3' || lowered.includes('v3') || lowered.includes('clmm')) return 'v3';
    if (lowered === 'pancake_swap' || lowered === 'uniswap') return 'v2';
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
