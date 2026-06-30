import { SolanaBroadcastService } from '../broadcast';
import type { SolanaBuiltTransaction, SolanaSignerContext, SolanaSubmittedTrade } from './types';

export async function broadcastSolanaBuiltTransaction(input: {
  built: SolanaBuiltTransaction;
  signer: SolanaSignerContext;
  txSide?: 'buy' | 'sell';
  submitChannel?: import('@/types/extention').SubmitChannel;
  executionMode?: 'default' | 'turbo';
  debugRequestId?: string;
}): Promise<SolanaSubmittedTrade> {
  const { built, signer } = input;
  const requestId = String(input.debugRequestId || '').trim() || null;
  const broadcastStartedAt = Date.now();
  // #region debug-point G:submit-gap-broadcaster-before-sign
  fetch('http://127.0.0.1:7779/event', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'solana-submit-gap',
      runId: 'pre-fix',
      hypothesisId: 'E',
      location: 'broadcaster.ts:beforeSign',
      msg: '[DEBUG] submit gap broadcaster before sign',
      data: {
        requestId,
        txSide: input.txSide ?? null,
        submitChannel: input.submitChannel ?? null,
        executionMode: input.executionMode ?? null,
        source: built.source,
        signerAddress: signer.signer.publicKey.toBase58(),
      },
      ts: Date.now(),
    }),
  }).catch(() => { });
  // #endregion
  built.transaction.sign([signer.signer]);
  const blockhash = built.blockhash ?? built.transaction.message.recentBlockhash;
  // #region debug-point G:submit-gap-broadcaster-after-sign
  fetch('http://127.0.0.1:7779/event', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'solana-submit-gap',
      runId: 'pre-fix',
      hypothesisId: 'E',
      location: 'broadcaster.ts:afterSign',
      msg: '[DEBUG] submit gap broadcaster after sign',
      data: {
        requestId,
        txSide: input.txSide ?? null,
        submitChannel: input.submitChannel ?? null,
        executionMode: input.executionMode ?? null,
        source: built.source,
        signerAddress: signer.signer.publicKey.toBase58(),
        blockhash,
        elapsedMs: Date.now() - broadcastStartedAt,
      },
      ts: Date.now(),
    }),
  }).catch(() => { });
  // #endregion
  const submission = await SolanaBroadcastService.sendSignedTransaction({
    transaction: built.transaction,
    txSide: input.txSide,
    submitChannel: input.submitChannel,
    executionMode: input.executionMode,
  });
  // #region debug-point G:submit-gap-broadcaster-after-broadcast
  fetch('http://127.0.0.1:7779/event', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'solana-submit-gap',
      runId: 'pre-fix',
      hypothesisId: 'E',
      location: 'broadcaster.ts:afterBroadcast',
      msg: '[DEBUG] submit gap broadcaster after broadcast',
      data: {
        requestId,
        txSide: input.txSide ?? null,
        submitChannel: input.submitChannel ?? null,
        executionMode: input.executionMode ?? null,
        txHash: submission.txHash,
        broadcastVia: submission.broadcastVia,
        broadcastUrl: submission.broadcastUrl ?? null,
        elapsedMs: Date.now() - broadcastStartedAt,
      },
      ts: Date.now(),
    }),
  }).catch(() => { });
  // #endregion
  return {
    source: built.source,
    txHash: submission.txHash,
    tokenMinOutWei: built.tokenMinOutWei,
    broadcastVia: submission.broadcastVia,
    broadcastUrl: submission.broadcastUrl,
    isBundle: submission.isBundle,
    plannerReason: built.plannerReason,
    blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
  };
}
