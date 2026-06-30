# [ABORTED] pumpfun-legacy-route

## Scope
- Verify whether normal SOL-side `pump.fun` trades now route through legacy layout instead of `BuyV2` / `SellV2`.
- Collect runtime evidence before any further business-logic fix.

## Symptoms
- `pump.fun` direct trades previously failed.
- Runtime errors included `Jupiter quote failed: 429`, `No direct Solana adapter available for platform:pump.fun`, `TokenOwnerOffCurveError`, and `ConstraintMut` on `fee_recipient`.

## Current Change Under Test
- `pumpfun` adapter now branches between legacy and unified V2 layouts.
- Build passed before this debug session started.

## Hypotheses
- H1: Normal SOL-side `pump.fun` trades are still entering unified V2 path because route detection is wrong.
- H2: The adapter enters legacy path, but the legacy instruction account metas still differ from the on-chain program expectation.
- H3: The adapter enters legacy path, but instruction data encoding for buy/sell does not match the expected discriminator or argument order.
- H4: The planner/runtime is still mutating platform or settlement mint selection before adapter build, causing the wrong path to be selected.
- H5: The adapter builds the correct instruction, but a later transaction assembly stage changes account ordering or inserts conflicting instructions.

## Evidence Plan
- Reuse runtime logs for adapter build path, instruction keys, and final message keys.
- Ask user to reload the extension and reproduce one buy and one sell on `pump.fun`.
- Compare logs against H1-H5, then decide whether another minimal fix is necessary.

## Session Status
- Debug server started at `http://127.0.0.1:7778` for session `pumpfun-legacy-route`.
- Instrumentation updated to write `planner`, `executor`, `pumpfun build`, and compiled message logs into this session.
- Added a new log point for the selected `pumpfun` layout: `legacy` vs `unified`.
- `npm run build` passed after instrumentation updates.

## Evidence
- After user reproduction, `.dbg/trae-debug-log-pumpfun-legacy-route.ndjson` was still missing.
- The old log file `.dbg/trae-debug-log-pump-direct-adapter.ndjson` still showed the previous `Buffer is not defined` failure path.
- This indicates the browser session likely did not load the newly built extension bundle yet.

## Hypothesis Status
- H1: `Unknown` until the browser loads the rebuilt extension and emits the new `pumpfun layout selected` log.
- H2: `Unknown` pending new post-fix runtime logs.
- H3: `Unknown` pending new post-fix runtime logs.
- H4: `Unknown` pending new post-fix runtime logs.
- H5: `Unknown` pending new post-fix runtime logs.

## Abort Note
- User requested to stop debugger-led flow and switch to direct log inspection.
- Debug server has been stopped.
- Follow-up moved to static analysis from the simulation log: `creator_vault` seed mismatch on `BuyExactSolIn`.
