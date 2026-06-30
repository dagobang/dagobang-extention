# Debug Session: solana-submit-gap

- Status: [OPEN]
- Started At: 2026-06-25
- Scope: SOL buy submit latency gap vs GMGN

## Symptoms

- Actual:
  - Extension SOL buy submit latency is commonly around 0.8s.
  - GMGN page-side buy submit latency can be around 0.25s.
- Expected:
  - Extension submit latency should move closer to GMGN, ideally near 0.5s or below when network conditions are comparable.

## Falsifiable Hypotheses

1. `getSigner()` or unlocked-wallet path adds measurable local delay before planning starts.
2. `planSolanaTrade()` still performs non-trivial per-submit work that GMGN avoids or precomputes.
3. `pumpfun adapter.build()` remains the dominant local delay, especially account reads and per-submit instruction assembly.
4. Fresh blockhash fetch is now a necessary correctness cost, but it may still be preheated or sourced earlier than final build.
5. Broadcast path is not the main gap; most of the delta exists before `sendSignedTransaction()` begins.

## Evidence Plan

- Add request-correlated timing logs for signer, planner, adapter build, blockhash fetch, and broadcast entry/exit.
- Reproduce on the same token with comparable click timing and inspect submit sub-stage breakdown.
- Only optimize after runtime evidence confirms the dominant segment.

## Notes

- Per debugging protocol, no business logic changes before instrumentation evidence is collected.

## Evidence

- Buy sample A:
  - `getSigner`: ~2ms
  - `buildTradeRequest`: ~1ms
  - `planSolanaTrade`: ~3ms
  - `adapter.build`: ~737ms
  - within build, fresh `blockhash`: ~237ms
  - `broadcast`: ~271ms
  - total execute path: ~1012ms
- Buy sample B:
  - `getSigner`: ~1ms
  - `buildTradeRequest`: ~1ms
  - `planSolanaTrade`: ~230ms
  - `adapter.build`: ~443ms
  - within build, fresh `blockhash`: ~223ms
  - `broadcast`: ~67ms
  - total execute path: ~741ms
- Sell control samples are similar:
  - `planSolanaTrade`: ~219-226ms
  - `adapter.build`: ~444-460ms
  - fresh `blockhash`: ~218-225ms
  - `broadcast`: ~66-69ms
  - total execute path: ~730-755ms

## Interim Conclusions

1. `getSigner()` is not the bottleneck.
2. `buildTradeRequest()` is not the bottleneck.
3. `broadcast` is usually small when RPC is healthy, often only ~67ms.
4. Fresh `blockhash` fetch is a fixed submit cost of about ~220-237ms.
5. The largest remaining submit gap is before broadcast, mainly `planSolanaTrade` and the non-blockhash part of `adapter.build`.

## Candidate Optimizations

- Push route/planner warming earlier so `planSolanaTrade()` stops paying ~200ms on submit.
- Split `adapter.build()` into:
  - static/prewarmable account reads and instruction inputs
  - final per-submit blockhash + final message assembly
- Keep fresh blockhash correctness, but move connection warming and request timing earlier so the fetch rides a hot connection.

## Implemented Fix

- Added short-TTL planner cache and explicit planner prewarm during SOL turbo prewarm.
- Marked planned adapter source on the request so `pumpfun.build()` can skip the immediately repeated `supportsTrade()` check.
- Added immutable mint-program cache so repeated `getMintProgramId()` no longer re-reads mint account info.

## Post-Fix Evidence

- Buy sample C:
  - `getSigner`: ~1ms
  - `buildTradeRequest`: ~1ms
  - `planSolanaTrade`: ~0ms
  - `adapter.build`: ~421ms
  - within build, fresh `blockhash`: ~217ms
  - `broadcast`: ~75-76ms
  - total execute path: ~497ms
- Buy sample D:
  - total execute path: ~503ms
- Sell sample after the same optimization:
  - `planSolanaTrade`: ~1ms
  - `adapter.build`: ~401ms
  - within build, fresh `blockhash`: ~195ms
  - `broadcast`: ~66ms
  - total execute path: ~468ms

## Comparison

- `planSolanaTrade()` dropped from ~199-230ms to ~0-1ms on warm hits.
- Buy submit path dropped from ~741-1012ms to ~497-503ms in the observed post-fix samples.
- Remaining dominant cost is now the unavoidable fresh `blockhash` fetch plus a much smaller residual build segment.

## Latest Evidence

- New best buy sample:
  - `planSolanaTrade`: ~1ms
  - `adapter.build`: ~200ms
  - `broadcast`: ~80ms
  - total execute path: ~282ms
- New slower buy sample only ~7 seconds later:
  - `planSolanaTrade`: ~205ms
  - `adapter.build`: ~197ms
  - `broadcast`: ~68ms
  - total execute path: ~470ms
- This means the current dominant instability is no longer `build` or broadcast.
- The main variance now comes from whether planner warming/cache is actually hit on submit.

## Updated Conclusion

1. The floor is already close to GMGN once planner cost disappears.
2. The remaining gap to stable ~0.3-0.4s is mainly planner-hit stability, not signer, not build, not broadcast.
3. Next optimization should short-circuit planner for clearly identified Pump.fun tokens/pages instead of relying on a volatile warm cache hit.
