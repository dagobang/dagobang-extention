# Debug Session: slow-buy-sell-fail

- Status: [OPEN]
- Created: 2026-06-29
- Scope:
  - Solana direct PumpSwap buy still feels slow on-chain under `gas 1.1x`, while `gas 1.2x` lands in about `1~3s`
  - Solana sell still fails from the user perspective
- Guardrails:
  - No business-logic changes before fresh runtime evidence is re-read and hypotheses are tested
  - Treat buy latency and sell failure as separate hypotheses unless logs prove a shared root cause

## Hypotheses

1. Buy under `1.1x` is no longer blocked by missing priority-fee instructions, but its effective fee is still below the current landing threshold.
2. Some latest buy attempts are not actually "slow confirms"; they fail earlier due to build/broadcast constraints such as transaction size.
3. Sell reaches broadcast, but the result returned through the request bridge flips to failure before confirmation finishes, creating a false negative in the UI.
4. Sell failures come from a real chain-side error after broadcast, but the current response path collapses the detailed cause and only surfaces generic failure.
5. Buy and sell are diverging across different transaction shapes or route/prewarm states, so one fix should not be assumed to solve both.

## Evidence To Collect

- Latest `solana-trade-latency` buy samples for `standard` and `fast`
- Latest `pumpswap-offcurve` samples for sell from build -> broadcast -> confirm -> UI result
- Current bridge/executor path that produces `res.ok` for `tx:sellWithReceiptAuto`

## Next Step

- Re-read the newest runtime evidence and then decide whether the next change belongs in instrumentation or in a minimal fix.

## Session Update

- 2026-06-29:
  - Re-checked latest `solana-trade-latency` samples and confirmed buy slowness and sell failure should still be treated separately.
  - Buy evidence still points to a landing-threshold problem under lower fee presets, not a missing priority-fee instruction.
  - Sell evidence still reaches `broadcastDone` and `sellConfirmStart`, but existing logs did not expose the exact confirm-stage failure.
  - Added minimal instrumentation only:
    - `services/chain/solana/rpc.ts`
      - `rpc.ts:confirmSignature:error`
      - `rpc.ts:confirmSignature:softTimeout`
    - `entrypoints/background.ts`
      - `background.ts:tx:sellWithReceiptAuto:catch`
  - Purpose of the new logs:
    - expose inner `AggregateError.errors` when `Promise.any` collapses confirm failures,
    - capture whether sell fails in `submit` or `receipt` stage before background returns `{ ok:false }`.
  - New user-provided runtime evidence:
    - buy on token `4U4U8oXw...pump` returned `VersionedTransaction too large: 1664 bytes (max: encoded/raw 1644/1232)`.
    - sell on the same token surfaced `InstructionError -> Custom 6023`, so the current failure is not just a generic UI false negative.
  - Minimal fix applied from evidence:
    - `packages/solana-dex-core/src/protocols/pumpswap/adapter.ts`
      - compile the PumpSwap transaction and measure serialized bytes,
      - if turbo memo pushes the transaction above Solana's `1232` raw-byte limit, rebuild once without the memo,
      - emit tx-size debug logs for before/after comparison.
  - New evidence after the tx-size fix:
    - user-provided buy failure `InstructionError[5].Custom(101)` matches historical `InstructionFallbackNotFound (0x65)`.
    - current source still had `useExactQuoteIn = isBuy`, which would send `buy_exact_quote_in` for every PumpSwap buy.
    - local `pumpswap-offcurve` post-fix logs already contain a successful submit sample on the same token with:
      - `useExactQuoteIn=false`
      - `tokenAmount=minBaseAmountOut`
      - `solAmount=10000000`
      - `wrapAmount=10000000`
    - therefore the buy regression is confirmed as wrong instruction variant selection, not user operation.
  - Follow-up fix applied:
    - force current PumpSwap buy path back to legacy `Buy` discriminator until new runtime evidence proves `buy_exact_quote_in` is supported on this migrated route.
  - New evidence after buy recovery:
    - user confirmed buy is restored.
    - sell still fails with `InstructionError[4].Custom(6023)` across all submit RPCs.
    - static comparison against local `sol-trade-sdk` reference shows current project's sell instruction was missing migrated-route trailing accounts that the reference includes:
      - `poolV2`
      - buyback / extra fee recipient
      - buyback / extra fee recipient ATA
    - current project only appended these on buy, not on sell.
  - Minimal sell fix applied:
    - `packages/solana-dex-core/src/protocols/pumpswap/adapter.ts`
      - append `poolV2` and buyback recipient trailing accounts for sell too,
      - align cashback sell remaining accounts with the reference ordering when quote ATA exists.
  - New Mayhem finding:
    - current project decoded `isMayhemMode` from PumpFun / PumpSwap state but did not actually use it in instruction assembly.
    - current `pumpfun` builders hard-coded `NORMAL_FEE_RECIPIENT`.
    - current `pumpswap` builder hard-coded protocol fee recipient selection even when `poolState.isMayhemMode === true`.
    - local `sol-trade-sdk` reference switches the primary fee recipient to a dedicated `MAYHEM_FEE_RECIPIENTS` pool for both PumpFun and PumpSwap.
  - Minimal Mayhem fix applied:
    - `packages/solana-dex-core/src/protocols/pumpfun/constants.ts`
      - add `MAYHEM_FEE_RECIPIENTS`.
    - `packages/solana-dex-core/src/protocols/pumpfun/adapter.ts`
      - choose Mayhem fee recipient when `state.isMayhemMode`.
      - derive the quote ATA from the selected Mayhem fee recipient in unified layout.
    - `packages/solana-dex-core/src/protocols/pumpswap/adapter.ts`
      - choose Mayhem fee recipient when `ctx.poolState.isMayhemMode`.
  - Validation:
    - `GetDiagnostics` on edited files: clean
    - `npm run compile`: passed
