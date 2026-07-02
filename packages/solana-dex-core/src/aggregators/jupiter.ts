import { VersionedTransaction } from '@solana/web3.js';
import type { SolanaBuiltTransaction, SolanaTradeAdapter, SolanaTradeRequest } from '../types';
import { bytesFromBase64 } from '../utils';

const JUPITER_LITE_SWAP_BASE = 'https://lite-api.jup.ag/swap/v1';

type JupiterQuoteResponse = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  priceImpactPct?: string;
  routePlan?: Array<unknown>;
};

type JupiterSwapResponse = {
  swapTransaction: string;
  lastValidBlockHeight: number;
};

async function fetchJupiterQuote(input: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}): Promise<JupiterQuoteResponse> {
  const url = `${JUPITER_LITE_SWAP_BASE}/quote?${new URLSearchParams({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amount: input.amount,
    slippageBps: String(input.slippageBps),
    restrictIntermediateTokens: 'true',
    instructionVersion: 'V2',
  }).toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Jupiter quote failed: ${response.status}`);
  }
  const data = await response.json() as JupiterQuoteResponse & { error?: string };
  if (data?.error) throw new Error(data.error);
  if (!data?.outAmount || !data?.otherAmountThreshold) {
    throw new Error('Jupiter quote unavailable');
  }
  return data;
}

async function fetchJupiterSwapTransaction(input: {
  quote: JupiterQuoteResponse;
  userPublicKey: string;
  wrapAndUnwrapSol?: boolean;
}): Promise<JupiterSwapResponse> {
  const response = await fetch(`${JUPITER_LITE_SWAP_BASE}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: input.quote,
      userPublicKey: input.userPublicKey,
      wrapAndUnwrapSol: input.wrapAndUnwrapSol ?? true,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!response.ok) {
    throw new Error(`Jupiter swap build failed: ${response.status}`);
  }
  const data = await response.json() as JupiterSwapResponse & { error?: string };
  if (data?.error) throw new Error(data.error);
  if (!data?.swapTransaction || typeof data.lastValidBlockHeight !== 'number') {
    throw new Error('Jupiter swap transaction unavailable');
  }
  return data;
}

export const jupiterTradeAdapter: SolanaTradeAdapter = {
  capability: {
    source: 'jupiter',
    mode: 'aggregator',
    supportsBuy: true,
    supportsSell: true,
    platforms: ['*'],
  },

  supportsTrade(_input: SolanaTradeRequest): boolean {
    return true;
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    const quote = await fetchJupiterQuote({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amount: input.amount,
      slippageBps: input.slippageBps,
    });
    const swap = await fetchJupiterSwapTransaction({
      quote,
      userPublicKey: input.ownerAddress,
      wrapAndUnwrapSol: true,
    });
    const transaction = VersionedTransaction.deserialize(bytesFromBase64(swap.swapTransaction));
    return {
      source: 'jupiter',
      transaction,
      protectionMinOutWei: quote.otherAmountThreshold,
      quotedOutWei: quote.outAmount,
      blockhash: transaction.message.recentBlockhash,
      lastValidBlockHeight: swap.lastValidBlockHeight,
      quote,
    };
  },
};
