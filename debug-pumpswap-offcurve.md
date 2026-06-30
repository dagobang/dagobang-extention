[OPEN] pumpswap-offcurve

# Debug Session: pumpswap-offcurve

## Symptom
- Pump.fun migrated token routed to PumpSwap still fails.
- Current observed raw error: `TokenOwnerOffCurveError`.
- Sample token: `4U4U8oXwDyVXGeTffMXds4NAgBgLFwq3wNvTCRTSpump`
- Sample pool from tokenInfo: `Eg2SxQ3zkT3ZjQmnXg318aVUR8eo4YfUPUVzeU6riGJN`

## Constraints
- Before evidence is collected, do not change business logic.
- First code change in this session must be instrumentation only.

## Hypotheses
1. One ATA derivation in `pumpswap/adapter.ts` is still called with an off-curve owner while `allowOwnerOffCurve` is false.
2. The failing ATA derivation is not the current fee recipient path, but another owner such as pool, creator vault, or user volume accumulator derived under a different branch.
3. The routed pool for this migrated token is not the actual execution pool, causing downstream account derivation to use the wrong owner/mint combination.
4. The error is thrown before instruction assembly completes, so the failure point can be isolated by wrapping each PDA/ATA derivation with step-level reporting.
5. The current route classification (`pump_amm` -> `pumpswap`) is correct, but the transaction builder is still choosing accounts from a mismatched pool lookup path.

## Plan
1. Start Debug Server for this session.
2. Add instrumentation around PumpSwap pool selection and every ATA/PDA derivation in `adapter.ts`.
3. Reproduce with the provided token and inspect runtime logs.
4. Confirm the exact failing owner/mint pair before changing any business logic.

## Evidence Summary
- Confirmed: the selected pool matches `tokenInfo.tpool_pool_address` (`Eg2SxQ3zkT3ZjQmnXg318aVUR8eo4YfUPUVzeU6riGJN`).
- Confirmed: `feeRecipientAta` was the original `TokenOwnerOffCurveError` source and was fixed by allowing off-curve ATA derivation.
- Confirmed: RPC aggregation was only the surface symptom; underlying simulation errors were identical across providers.
- Confirmed: `pool` must be writable, otherwise simulation fails with `ConstraintMut(pool)`.
- Current failing runtime symptom after those fixes: `AnchorError ... buy.rs:438 ... Overflow (6023)`.

## Current Hypothesis
1. The current project still builds PumpSwap buys with the legacy `buy(base_amount_out, max_quote_amount_in)` shape, while the live Pump AMM path now expects exact-quote-in style buy semantics for this UI flow.
2. The current project omits the buy `track_volume` byte (`OptionBool` in `pump_amm.json`), so buy instruction data is still behind the deployed IDL.
3. The current project omits conditional trailing accounts for buy flows, especially the cashback accumulator ATA and `pool-v2` when `coin_creator != default`.

## Latest Fix Attempt
- Switched PumpSwap buy construction from legacy quote-derived buy semantics toward exact-quote-in semantics:
  - buy instruction data now encodes `spendable_quote_in`, `min_base_amount_out`, and `track_volume`.
  - buy-side `tokenMinOutWei` now returns the min base amount out instead of the unslipped quote result.
  - buy-side WSOL wrapping now uses the exact input quote amount instead of the old max-quote path.
- Added conditional trailing accounts on buy:
  - `userVolumeAccumulatorQuoteAta` when the pool is cashback-enabled.
  - `pool-v2` when `coin_creator != default`.
- Kept sell path unchanged for now to minimize blast radius.

## Result Of Latest Attempt
- Falsified: the live Pump AMM program for this route does **not** accept `buy_exact_quote_in`.
- Runtime evidence after switching discriminators:
  - `InstructionFallbackNotFound (0x65)`
  - `AnchorError occurred. Error Code: InstructionFallbackNotFound. Error Number: 101.`
- Action taken:
  - Reverted back to legacy `Buy` discriminator.
  - Kept the newly added runtime evidence fields and the conditional `pool-v2` account path for continued investigation on the legacy buy flow.
