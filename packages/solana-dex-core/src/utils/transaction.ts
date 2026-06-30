import {
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

export function toVersionedTransaction(transaction: Transaction): VersionedTransaction {
  if (!transaction.feePayer) {
    throw new Error('Transaction fee payer is missing');
  }
  if (!transaction.recentBlockhash) {
    throw new Error('Transaction recent blockhash is missing');
  }

  const message = new TransactionMessage({
    payerKey: transaction.feePayer,
    recentBlockhash: transaction.recentBlockhash,
    instructions: transaction.instructions,
  }).compileToV0Message();

  return new VersionedTransaction(message);
}
