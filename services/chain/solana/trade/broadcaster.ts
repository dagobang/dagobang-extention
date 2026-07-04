import { SolanaBroadcastService } from '../broadcast';
import type { SolanaBuiltTransaction, SolanaSignerContext, SolanaSubmittedTrade } from './types';

export async function broadcastSolanaBuiltTransaction(input: {
  built: SolanaBuiltTransaction;
  signer: SolanaSignerContext;
  txSide?: 'buy' | 'sell';
  submitChannel?: import('@/types/extention').SubmitChannel;
  solanaFeeMode?: import('@/types/extention').SolanaFeeMode;
  executionMode?: 'default' | 'turbo';
  debugRequestId?: string;
}): Promise<SolanaSubmittedTrade> {
  const { built, signer } = input;
  const requestId = String(input.debugRequestId || '').trim() || null;
  const broadcastStartedAt = Date.now();
  built.transaction.sign([signer.signer]);
  const blockhash = built.blockhash ?? built.transaction.message.recentBlockhash;
  let submission;
  try {
    submission = await SolanaBroadcastService.sendSignedTransaction({
      transaction: built.transaction,
      txSide: input.txSide,
      submitChannel: input.submitChannel,
      solanaFeeMode: input.solanaFeeMode,
      executionMode: input.executionMode,
    });
  } catch (error: any) {
    throw error;
  }
  return {
    source: built.source,
    txHash: submission.txHash,
    protectionMinOutWei: built.protectionMinOutWei,
    quotedOutWei: built.quotedOutWei ?? null,
    broadcastVia: submission.broadcastVia,
    broadcastUrl: submission.broadcastUrl,
    isBundle: submission.isBundle,
    plannerReason: built.plannerReason,
    blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
  };
}
