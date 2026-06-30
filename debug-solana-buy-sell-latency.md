# Debug Session: solana-buy-sell-latency

- Status: [OPEN]
- Created: 2026-06-29
- Scope:
  - Solana direct PumpSwap buy remains slow on-chain under `gas 1.1x`, and only reaches roughly `1~3s` under `gas 1.2x`
  - Solana sell still fails from the user perspective
- Guardrails:
  - No business-logic changes before fresh runtime evidence is re-read and hypotheses are tested
  - Separate buy latency from sell failure; do not treat them as one root cause without evidence

## Hypotheses

1. Buy latency is now dominated by confirmation-path or RPC fanout behavior, not by priority-fee application itself.
2. `gas 1.1x` still maps to an effective priority fee that is too low for current congestion, while `1.2x` crosses a threshold that gets inclusion within `1~3s`.
3. Sell is reaching broadcast successfully, but the confirmation/result propagation path is timing out, swallowing the real error, or returning a false negative to the UI.
4. Buy and sell are following different trailing-account / transaction-shape paths, so buy slowness and sell failure come from different layers.
5. The recent buy-path edits changed transaction size or account set enough to affect routing/latency, but sell failure is still downstream of broadcast rather than instruction construction.

## Evidence To Collect

- Latest `solana-trade-latency` log samples for buy under `gas 1.1x` and `1.2x`
- Latest `pumpswap-offcurve` log samples for sell from build -> broadcast -> confirm -> UI result
- Current `broadcast.ts` and `rpc.ts` confirm/error propagation points

## Next Step

- Re-read the newest runtime evidence first, then decide whether the next edit belongs in instrumentation or in a minimal fix.
