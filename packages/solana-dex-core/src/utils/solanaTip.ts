import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import type { SolanaTradeRequest } from '../types';

function parseSolToLamports(raw: string): bigint | null {
  const value = String(raw || '').trim();
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [wholePart, fractionPart = ''] = value.split('.');
  const whole = BigInt(wholePart || '0');
  const fraction = BigInt((fractionPart.padEnd(9, '0')).slice(0, 9) || '0');
  return (whole * 1_000_000_000n) + fraction;
}

export function buildSolanaTipTransferInstructions(input: SolanaTradeRequest): TransactionInstruction[] {
  const rawInput = (input.rawInput ?? {}) as Record<string, unknown>;
  const feeMode = typeof rawInput.solanaFeeMode === 'string' ? rawInput.solanaFeeMode.trim() : 'pf';
  if (feeMode !== 'tip' && feeMode !== 'pf_and_tip') return [];
  const tipRecipient = typeof rawInput.solanaTipRecipient === 'string' ? rawInput.solanaTipRecipient.trim() : '';
  const tipNative = typeof rawInput.solanaTipNative === 'string' ? rawInput.solanaTipNative.trim() : '';
  const lamports = parseSolToLamports(tipNative);
  if (!tipRecipient || !lamports || lamports <= 0n) return [];
  return [
    SystemProgram.transfer({
      fromPubkey: new PublicKey(input.ownerAddress),
      toPubkey: new PublicKey(tipRecipient),
      lamports: Number(lamports),
    }),
  ];
}
