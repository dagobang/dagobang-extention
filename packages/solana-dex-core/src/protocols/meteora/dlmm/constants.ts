import { PublicKey } from '@solana/web3.js';

export const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const METEORA_DLMM_SWAP2_DISCRIMINATOR = Uint8Array.from([65, 75, 63, 76, 235, 91, 91, 136]);

export const BIN_ARRAY_SIZE = 70;
export const SCALE_OFFSET = 64;
export const BASIS_POINT_MAX = 10_000;
export const FEE_PRECISION = 1_000_000_000;
export const MAX_BIN_ARRAYS_FOR_SWAP = 4;
