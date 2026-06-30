# Debug Session: solana-trade-latency
- **Status**: [OPEN]
- **Issue**: SOL chain trade latency is too high; submit takes 1-2s and on-chain receipt takes 1-8s.
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-solana-trade-latency.ndjson

## Reproduction Steps
1. Open a SOL token quick trade panel.
2. Submit buy or sell once in `default` mode and once in `turbo` mode.
3. Observe submit elapsed time and receipt elapsed time in UI/logs.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | Submit latency is inflated by pre-submit balance/account reads in UI or executor. | High | Low | Rejected for current repro: sell prep is 2ms; buy has no extra prep log gap before executor start. |
| B | Protected RPC fanout/race adds extra wait before first successful broadcast returns. | High | Med | Rejected as primary cause: buy rpc submit 318ms, sell rpc submit 71ms. |
| C | Receipt latency is dominated by confirmation polling/commitment strategy rather than actual network inclusion. | High | Med | Partially confirmed: current repro buy confirm 620ms, sell confirm 675ms, not the main source of 1.9-2.4s total. |
| D | Trade planning/building work is being counted inside "submit" time, making submit appear slower than actual broadcast. | Med | Med | Confirmed: buy plan+build 203ms+1035ms, sell plan+build 225ms+949ms; broadcast itself is only 318ms/71ms. |

## Log Evidence
- Buy (`FEZ3...pump`):
  - UI buy total request: 2442ms
  - Executor submit elapsed: 1559ms
  - Plan trade: 203ms
  - Adapter build: 1035-1156ms
  - RPC submit winner: 318ms via `rpc.shyft.to`
  - Confirm done: 620ms
- Sell (`FEZ3...pump`):
  - UI sell amount prepare: 2ms
  - UI sell total request: 1928ms
  - Executor submit elapsed: 1251ms
  - Plan trade: 208-225ms
  - Adapter build: 820-949ms
  - RPC submit winner: 71ms via `rpc.shyft.to`
  - Confirm done: 675ms
- Pump.fun legacy build sub-stages:
  - Buy:
    - `supportsTrade`: 209ms
    - `bonding_curve + mint program`: 213ms
    - `creator_vault / sharing_config`: +243ms (cumulative 456ms)
    - user ATA existence check: 266ms
    - `getLatestBlockhash`: 220ms
    - total legacy instruction build: 943ms
  - Sell:
    - `supportsTrade`: 207ms
    - `bonding_curve + mint program`: 200ms
    - `creator_vault / sharing_config`: +205ms (cumulative 405ms)
    - `getLatestBlockhash`: 204ms
    - total legacy instruction build: 610ms

## Verification Conclusion
- For the captured repro, the main inflation inside "submit" is not broadcast. It is mostly `planSolanaTrade + adapter.build`.
- Current receipt path is around 0.6-0.7s in turbo/processed, which is already close to target and far smaller than the slow submit stage.
- The slowest pre-submit path is a chain of sequential Pump.fun account reads: `supportsTrade(loadBondingCurveState)` -> `buildLegacyInstruction(loadBondingCurveState)` -> `resolvePumpfunCreatorVault(sharing_config)` -> `user ATA exists` -> `getLatestBlockhash`.
- These are good candidates for prewarm/cache except final blockhash, which should only be warmed with a very short TTL.

## Post-Fix Evidence
- Build with dedupe + prewarm wiring is compiled and loaded.
- Post-fix buy (`FEZ3...pump`):
  - UI total: `2079ms` vs pre-fix `2442ms`
  - `submitElapsedMs`: `1168ms` vs pre-fix `1543ms`
  - adapter build: `837ms` vs pre-fix `1156ms`
  - rpc submit: `125ms` vs pre-fix `180ms`
  - confirm: `656ms` vs pre-fix `677ms`
- Post-fix sell (`FEZ3...pump`):
  - UI total: `1604ms` vs pre-fix `1928ms`
  - `submitElapsedMs`: `922ms` vs pre-fix `1101ms`
  - adapter build: `611ms` vs pre-fix `820ms`
  - rpc submit: `76ms` vs pre-fix `71ms`
  - confirm: `679ms` vs pre-fix `413-675ms`

## Post-Fix Interpretation
- Confirmed: removing repeated reads between `supportsTrade` and `build` produced a real submit improvement of roughly `180-375ms`.
- Confirmed: `supportsTrade` is now effectively free during build (`elapsedMs: 0` in post-fix logs), showing the state cache is hit.
- Partially confirmed: prewarm wiring is in place, but short TTL `blockhash` prewarm did not obviously hit in this repro, because blockhash fetch still cost about `198-227ms`.
- Residual bottleneck: `buildLegacyInstruction:stateDone` still costs about `207ms`, and `creatorVault` still adds about `202ms`. Those are now the main remaining pre-submit reads.

## Current Fix Round
- Added page-stage SOL Pump.fun base prewarm triggered by token page load, without waiting for wallet unlock or tokenInfo resolution.
- Added second-stage owner-aware prewarm once wallet address is available, so ATA existence can be warmed separately.
- Extended prewarm request shape to carry `platform`, `fromAddress`, and `submitChannel`, so SOL can infer Pump.fun earlier from page context.
- Added a lightweight first-click gate: if SOL Pump.fun base prewarm is still in flight, buy/sell waits briefly for the warm-up promise instead of immediately racing into cold reads.

## Latest Verification
- First buy after waiting on page:
  - adapter build: `813ms`
  - submit elapsed: `1191ms`
  - receipt: `252ms`
  - Interpretation: receipt improved a lot, but build prewarm was not fully consumed before the first buy.
- Subsequent sell on same token:
  - plan: `1ms`
  - adapter build: `407ms`
  - submit elapsed: `470ms`
  - receipt: `369ms`
  - Interpretation: this is the clearest proof that page-stage warm caches are now helping. `creatorVault` no longer adds an extra serialized hop, and total submit is already near the target band.
- Remaining issue:
  - First trade on page still races with warm-up completion.
  - Warm-up trigger timing is improved, but not yet guaranteed to finish before the user's first click.

## First-Click Gate Verification
- Fast first buy after adding the lightweight gate:
  - adapter build: `895ms`
  - submit elapsed: `1318ms`
  - receipt: `525ms`
- Conclusion:
  - The lightweight gate did **not** materially improve the first buy.
  - Current evidence suggests the problem is not "wait time too short" inside the gate.
  - More likely, the first click happens before SOL Pump.fun prewarm has actually started or before the request becomes available in the in-flight map.
