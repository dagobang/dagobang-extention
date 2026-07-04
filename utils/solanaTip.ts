import { parseUnits } from 'viem';
import type { PriorityFeePreset, PriorityFeePresetConfig, SolanaSwqosProviderType } from '@/types/extention';
import { ChainId } from '@/constants/chains/chainId';

export const DEFAULT_SOLANA_TIP_PRESET_VALUES: PriorityFeePresetConfig = {
  none: '0',
  slow: '0.001',
  standard: '0.002',
  fast: '0.005',
};

const SOLANA_TIP_ACCOUNT_MAP: Record<SolanaSwqosProviderType, readonly string[]> = {
  jito: [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  ],
  nextblock: [
    'NextbLoCkVtMGcV47JzewQdvBpLqT9TxQFozQkN98pE',
    'NexTbLoCkWykbLuB1NkjXgFWkX9oAtcoagQegygXXA2',
    'NeXTBLoCKs9F1y5PJS9CKrFNNLU1keHW71rfh7KgA1X',
    'NexTBLockJYZ7QD7p2byrUa6df8ndV2WSd8GkbWqfbb',
    'neXtBLock1LeC67jYd1QdAa32kbVeubsfPNTJC1V5At',
    'nEXTBLockYgngeRmRrjDV31mGSekVPqZoMGhQEZtPVG',
    'NEXTbLoCkB51HpLBLojQfpyVAMorm3zzKg7w9NFdqid',
    'nextBLoCkPMgmG8ZgJtABeScP35qLa2AMCNKntAP7Xc',
  ],
  blox: [
    '3UQUKjhMKaY2S6bjcQD6yHB7utcZt5bfarRCmctpRtUd',
    'FogxVNs6Mm2w9rnGL1vkARSwJxvLE8mujTv3LK8RnUhF',
    'bLx7MvxGaKdKL7mEbpk9tC79z6MnBSJoJkuaEAPu6Nd',
    'bLx7XBqSg3LUPVf1bRgCnkJmgVZR8QEgDJBPqcRLHvp',
    'bLx8KeZxinPwy6kkUgyzMLeqb2ARNsWjADG1dhSsVba',
    'bLxADBknoNj8WAGw2W6GBYeq848Xx6ajhaymV1YvrHm',
    'bLxAc88vRBwvcUQJEgcxNfBLvHPikY4csNsUmPeWea2',
    'bLxQ88oCiTsL8Xj4YWekKi1hjrgmbE3J3FFZ2xZHR3h',
    'bLxS7NoLuynNRJ4mCnEE2YbtwJFttYsEyp2ME7rp2yt',
    'bLxW6mCov7VEbrKc3S9tcBRcfSzRnLCbNp3Dfn3SJG5',
    'bLxXSGXs4mYPTC5okZXed1qzvjNwNJ48QJ82hT2V7w7',
    'bLxYi3vojbbB7hVzVDVTdBLVPhp7GJ3ZB3BwdK5sFXi',
    'bLxhLPgBXtUpX4b1bH3HatuMGMSKT9GnwtuCGiMSAqe',
    'bLxpY1mniuFW4PgkNA4JiNxoeKHFszryi6tNgyZAiAA',
    'bLxuETxd2tgWxBALNwPzAfHhsik4BzD3nrEBCiPNZQD',
    'bLxuL2gK5FW7xfahvwLrxLyW76vcCpNsKQY2CmnE6kV',
    'bLxv4Hnub7nDJWHs8s17o9bGU65Bnx6Yqp2fqtMgHmm',
  ],
  temporal: [
    'TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq',
    'noz3jAjPiHuBPqiSPkkugaJDkJscPuRhYnSpbi8UvC4',
    'noz3str9KXfpKknefHji8L1mPgimezaiUyCHYMDv1GE',
    'noz6uoYCDijhu1V7cutCpwxNiSovEwLdRHPwmgCGDNo',
    'noz9EPNcT7WH6Sou3sr3GGjHQYVkN3DNirpbvDkv9YJ',
    'nozc5yT15LazbLTFVZzoNZCwjh3yUtW86LoUyqsBu4L',
    'nozFrhfnNGoyqwVuwPAW4aaGqempx4PU6g6D9CJMv7Z',
    'nozievPk7HyK1Rqy1MPJwVQ7qQg2QoJGyP71oeDwbsu',
    'noznbgwYnBLDHu8wcQVCEw6kDrXkPdKkydGJGNXGvL7',
    'nozNVWs5N8mgzuD3qigrCG2UoKxZttxzZ85pvAQVrbP',
    'nozpEGbwx4BcGp6pvEdAh1JoC2CQGZdU6HbNP1v2p6P',
    'nozrhjhkCr3zXT3BiT4WCodYCUFeQvcdUkM7MqhKqge',
    'nozrwQtWhEdrA6W8dkbt9gnUaMs52PdAv5byipnadq3',
    'nozUacTVWub3cL4mJmGCYjKZTnE9RbdY5AP46iQgbPJ',
    'nozWCyTPppJjRuw2fpzDhhWbW355fzosWSzrrMYB1Qk',
    'nozWNju6dY353eMkMqURqwQEoM3SFgEKC6psLCSfUne',
    'nozxNBgWohjR75vdspfxR5H9ceC7XXH99xpxhVGt3Bb',
  ],
  zeroslot: [
    'Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3',
    'FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe',
    'ENxTEjSQ1YabmUpXAdCgevnHQ9MHdLv8tzFiuiYJqa13',
    '6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK',
    'Cix2bHfqPcKcM233mzxbLk14kSggUUiz2A87fJtGivXr',
  ],
  node1: [
    'node1PqAa3BWWzUnTHVbw8NJHC874zn9ngAkXjgWEej',
    'node1UzzTxAAeBTpfZkQPJXBAqixsbdth11ba1NXLBG',
    'node1Qm1bV4fwYnCurP8otJ9s5yrkPq7SPZ5uhj3Tsv',
    'node1PUber6SFmSQgvf2ECmXsHP5o3boRSGhvJyPMX1',
    'node1AyMbeqiVN6eoQzEAwCA6Pk826hrdqdAHR7cdJ3',
    'node1YtWCoTwwVYTFLfS19zquRQzYX332hs1HEuRBjC',
  ],
  flashblock: [
    'FLaShB3iXXTWE1vu9wQsChUKq3HFtpMAhb8kAh1pf1wi',
    'FLashhsorBmM9dLpuq6qATawcpqk1Y2aqaZfkd48iT3W',
    'FLaSHJNm5dWYzEgnHJWWJP5ccu128Mu61NJLxUf7mUXU',
    'FLaSHR4Vv7sttd6TyDF4yR1bJyAxRwWKbohDytEMu3wL',
    'FLASHRzANfcAKDuQ3RXv9hbkBy4WVEKDzoAgxJ56DiE4',
    'FLasHstqx11M8W56zrSEqkCyhMCCpr6ze6Mjdvqope5s',
    'FLAShWTjcweNT4NSotpjpxAkwxUr2we3eXQGhpTVzRwy',
    'FLasHXTqrbNvpWFB6grN47HGZfK6pze9HLNTgbukfPSk',
    'FLAshyAyBcKb39KPxSzXcepiS8iDYUhDGwJcJDPX4g2B',
    'FLAsHZTRcf3Dy1APaz6j74ebdMC6Xx4g6i9YxjyrDybR',
  ],
  blockrazor: [
    'FjmZZrFvhnqqb9ThCuMVnENaM3JGVuGWNyCAxRJcFpg9',
    '6No2i3aawzHsjtThw81iq1EXPJN6rh8eSJCLaYZfKDTG',
    'A9cWowVAiHe9pJfKAj3TJiN9VpbzMUq6E4kEvf5mUT22',
    'Gywj98ophM7GmkDdaWs4isqZnDdFCW7B46TXmKfvyqSm',
    '68Pwb4jS7eZATjDfhmTXgRJjCiZmw1L7Huy4HNpnxJ3o',
    '4ABhJh5rZPjv63RBJBuyWzBK3g9gWMUQdTZP2kiW31V9',
    'B2M4NG5eyZp5SBQrSdtemzk5TqVuaWGQnowGaCBt8GyM',
    '5jA59cXMKQqZAVdtopv8q3yyw9SYfiE3vUCbt7p8MfVf',
    '5YktoWygr1Bp9wiS1xtMtUki1PeYuuzuCF98tqwYxf61',
    '295Avbam4qGShBYK7E9H5Ldew4B3WyJGmgmXfiWdeeyV',
    'EDi4rSy2LZgKJX74mbLTFk4mxoTgT6F7HxxzG2HBAFyK',
    'BnGKHAC386n4Qmv9xtpBVbRaUTKixjBe3oagkPFKtoy6',
    'Dd7K2Fp7AtoN8xCghKDRmyqr5U169t48Tw5fEd3wT9mq',
    'AP6qExwrbRgBAVaehg4b5xHENX815sMabtBzUzVB4v8S',
  ],
  astralane: [
    'astrazznxsGUhWShqgNtAdfrzP2G83DzcWVJDxwV9bF',
    'astra4uejePWneqNaJKuFFA8oonqCE1sqF6b45kDMZm',
    'astra9xWY93QyfG6yM8zwsKsRodscjQ2uU2HKNL5prk',
    'astraRVUuTHjpwEVvNBeQEgwYx9w9CFyfxjYoobCZhL',
    'astraEJ2fEj8Xmy6KLG7B3VfbKfsHXhHrNdCQx7iGJK',
    'astraubkDw81n4LuutzSQ8uzHCv4BhPVhfvTcYv8SKC',
    'astraZW5GLFefxNPAatceHhYjfA1ciq9gvfEg2S47xk',
    'astrawVNP4xDBKT7rAdxrLYiTSTdqtUr63fSMduivXK',
  ],
};

const SOLANA_TIP_MINIMUM_NATIVE: Record<SolanaSwqosProviderType, string> = {
  jito: '0.000001',
  nextblock: '0.001',
  blox: '0.001',
  temporal: '0.001',
  zeroslot: '0.001',
  node1: '0.001',
  flashblock: '0.001',
  blockrazor: '0.001',
  astralane: '0.001',
};

export function getSolanaTipProviderLabel(type: SolanaSwqosProviderType): string {
  if (type === 'jito') return 'Jito';
  if (type === 'nextblock') return 'NextBlock';
  if (type === 'blox') return 'bloXroute';
  if (type === 'temporal') return 'Nozomi';
  if (type === 'zeroslot') return 'ZeroSlot';
  if (type === 'node1') return 'Node1';
  if (type === 'flashblock') return 'FlashBlock';
  if (type === 'blockrazor') return 'BlockRazor';
  if (type === 'astralane') return 'Astralane';
  return type;
}

export function getSolanaTipMinimumNative(type: SolanaSwqosProviderType): string {
  return SOLANA_TIP_MINIMUM_NATIVE[type];
}

export function getSolanaTipAccounts(type: SolanaSwqosProviderType): readonly string[] {
  return SOLANA_TIP_ACCOUNT_MAP[type] ?? [];
}

export function getRandomSolanaTipRecipient(type: SolanaSwqosProviderType): string {
  const accounts = getSolanaTipAccounts(type);
  if (!accounts.length) return '';
  const index = Math.floor(Math.random() * accounts.length);
  return accounts[index] ?? '';
}

export function getSolanaTipPresetValue(
  presets: PriorityFeePresetConfig | null | undefined,
  preset: PriorityFeePreset | null | undefined,
): string {
  const selectedPreset: PriorityFeePreset = preset === 'none' || preset === 'slow' || preset === 'standard' || preset === 'fast'
    ? preset
    : 'standard';
  const source = presets ?? DEFAULT_SOLANA_TIP_PRESET_VALUES;
  return source[selectedPreset] ?? DEFAULT_SOLANA_TIP_PRESET_VALUES[selectedPreset];
}

type SolanaSwqosSettingsLike = {
  enabled?: boolean;
  providers?: Array<{ enabled?: boolean; type?: string | null | undefined }> | null | undefined;
};

type SolanaTipChainSettingsLike = {
  solanaSwqos?: SolanaSwqosSettingsLike | null | undefined;
  buyTipPreset?: PriorityFeePreset | null | undefined;
  sellTipPreset?: PriorityFeePreset | null | undefined;
  buyTipPresets?: PriorityFeePresetConfig | null | undefined;
  sellTipPresets?: PriorityFeePresetConfig | null | undefined;
};

export function resolveEnabledSolanaSwqosProviderTypes(
  settings: SolanaSwqosSettingsLike | null | undefined,
): SolanaSwqosProviderType[] {
  const providers = Array.isArray(settings?.providers)
    ? settings.providers.filter((item) => item?.enabled)
    : [];
  return providers
    .map((item) => {
      const type = String(item?.type || '').trim().toLowerCase();
      return type === 'jito'
        || type === 'nextblock'
        || type === 'blox'
        || type === 'temporal'
        || type === 'zeroslot'
        || type === 'node1'
        || type === 'flashblock'
        || type === 'blockrazor'
        || type === 'astralane'
        ? type
        : null;
    })
    .filter((item): item is SolanaSwqosProviderType => !!item);
}

export function resolveSingleEnabledSolanaTipProvider(
  settings: SolanaSwqosSettingsLike | null | undefined,
): SolanaSwqosProviderType | null {
  const enabledProviderTypes = resolveEnabledSolanaSwqosProviderTypes(settings);
  return enabledProviderTypes.length === 1 ? enabledProviderTypes[0] : null;
}

export function resolveSolanaTipConfig(input: {
  chainId: number;
  side: 'buy' | 'sell';
  chainSettings?: SolanaTipChainSettingsLike | null | undefined;
}): { providerType: SolanaSwqosProviderType | null; tipNative: string; tipRecipient: string } {
  if (input.chainId !== ChainId.SOL) return { providerType: null, tipNative: '0', tipRecipient: '' };
  const chainSettings = input.chainSettings;
  if (!chainSettings?.solanaSwqos?.enabled) return { providerType: null, tipNative: '0', tipRecipient: '' };
  const providerType = resolveSingleEnabledSolanaTipProvider(chainSettings.solanaSwqos);
  if (!providerType) return { providerType: null, tipNative: '0', tipRecipient: '' };
  const selectedPreset = (input.side === 'buy'
    ? chainSettings.buyTipPreset
    : chainSettings.sellTipPreset) as PriorityFeePreset | undefined;
  const presetValues = input.side === 'buy'
    ? (chainSettings.buyTipPresets ?? DEFAULT_SOLANA_TIP_PRESET_VALUES)
    : (chainSettings.sellTipPresets ?? DEFAULT_SOLANA_TIP_PRESET_VALUES);
  const rawValue = presetValues[selectedPreset ?? 'none'] ?? DEFAULT_SOLANA_TIP_PRESET_VALUES[selectedPreset ?? 'none'];
  const tipNative = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!tipNative || tipNative === '0') {
    return { providerType, tipNative: '0', tipRecipient: '' };
  }
  const minimumTipNative = getSolanaTipMinimumNative(providerType);
  const normalizedTipNative = (() => {
    try {
      return parseUnits(tipNative, 9) >= parseUnits(minimumTipNative, 9) ? tipNative : minimumTipNative;
    } catch {
      return minimumTipNative;
    }
  })();
  return {
    providerType,
    tipNative: normalizedTipNative,
    tipRecipient: getRandomSolanaTipRecipient(providerType),
  };
}
