import { PublicKey } from '@solana/web3.js';

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_FEES_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const PUMP_GLOBAL_ACCOUNT = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

export const BUY_DISCRIMINATOR = Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234]);
export const BUY_EXACT_SOL_IN_DISCRIMINATOR = Uint8Array.from([56, 252, 116, 8, 158, 223, 205, 95]);
export const BUY_EXACT_QUOTE_IN_V2_DISCRIMINATOR = Uint8Array.from([194, 171, 28, 70, 104, 77, 91, 47]);
export const SELL_DISCRIMINATOR = Uint8Array.from([51, 230, 133, 164, 1, 127, 131, 173]);
export const BUY_V2_DISCRIMINATOR = Uint8Array.from([184, 23, 238, 97, 103, 197, 211, 61]);
export const SELL_V2_DISCRIMINATOR = Uint8Array.from([93, 246, 130, 60, 231, 233, 64, 178]);
export const SHARING_CONFIG_ACCOUNT_DISCRIMINATOR = Uint8Array.from([216, 74, 9, 0, 56, 140, 93, 75]);
export const SHARING_CONFIG_STATUS_ACTIVE = 1;
export const PUMPFUN_BASE_FEE_BPS = 95n;
export const PUMPFUN_CREATOR_FEE_BPS = 30n;

export const NORMAL_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
export const MAYHEM_FEE_RECIPIENTS = [
  new PublicKey('GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS'),
  new PublicKey('4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6'),
  new PublicKey('8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR'),
  new PublicKey('4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH'),
  new PublicKey('8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6'),
  new PublicKey('Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk'),
  new PublicKey('463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq'),
  new PublicKey('6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA'),
] as const;
export const BUYBACK_FEE_RECIPIENT = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');
export const PROTOCOL_EXTRA_FEE_RECIPIENTS = [
  new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD'),
  new PublicKey('9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7'),
  new PublicKey('GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL'),
  new PublicKey('3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR'),
  new PublicKey('5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6'),
  new PublicKey('EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL'),
  new PublicKey('5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD'),
  new PublicKey('A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW'),
] as const;
