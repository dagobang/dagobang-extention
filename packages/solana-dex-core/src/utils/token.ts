import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import type { SolanaDexRuntime } from '../types';
import { SOLANA_NATIVE_MINT } from '../constants';

const mintProgramIdCache = new Map<string, Promise<PublicKey>>();

export function findAta(params: {
  mint: PublicKey;
  owner: PublicKey;
  tokenProgramId?: PublicKey;
  allowOwnerOffCurve?: boolean;
}): PublicKey {
  return getAssociatedTokenAddressSync(
    params.mint,
    params.owner,
    params.allowOwnerOffCurve ?? false,
    params.tokenProgramId ?? TOKEN_PROGRAM_ID,
  );
}

export function createAtaIdempotentInstruction(params: {
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  associatedToken: PublicKey;
  tokenProgramId?: PublicKey;
}): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    params.payer,
    params.associatedToken,
    params.owner,
    params.mint,
    params.tokenProgramId ?? TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

export function buildWrapNativeInstructions(params: {
  payer: PublicKey;
  nativeAta: PublicKey;
  lamports: bigint;
  tokenProgramId?: PublicKey;
}): TransactionInstruction[] {
  return [
    SystemProgram.transfer({
      fromPubkey: params.payer,
      toPubkey: params.nativeAta,
      lamports: Number(params.lamports),
    }),
    createSyncNativeInstruction(params.nativeAta, params.tokenProgramId ?? TOKEN_PROGRAM_ID),
  ];
}

export function buildCloseTokenAccountInstruction(params: {
  account: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  tokenProgramId?: PublicKey;
}): TransactionInstruction {
  return createCloseAccountInstruction(
    params.account,
    params.destination,
    params.owner,
    [],
    params.tokenProgramId ?? TOKEN_PROGRAM_ID,
  );
}

export async function getMintProgramId(
  runtime: SolanaDexRuntime,
  mint: PublicKey,
  opts?: { cacheOnly?: boolean },
): Promise<PublicKey> {
  if (mint.toBase58() === SOLANA_NATIVE_MINT) return TOKEN_PROGRAM_ID;
  const key = mint.toBase58();
  const cached = mintProgramIdCache.get(key);
  if (cached) return await cached;
  if (opts?.cacheOnly) throw new Error('Mint program cache not ready');
  const promise = (async () => {
    const connection = await runtime.getConnection();
    const info = await connection.getAccountInfo(mint, 'confirmed');
    if (!info?.owner) throw new Error('Mint account not found');
    return info.owner;
  })().catch((error) => {
    mintProgramIdCache.delete(key);
    throw error;
  });
  mintProgramIdCache.set(key, promise);
  return await promise;
}
