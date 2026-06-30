# Debug Session: sol-quick-sell-timeout

- Status: OPEN
- Created At: 2026-06-30
- Scope: SOL chain quick trade sell fails immediately with `request timed out`, while buy still works.

## Symptom

- QuickTradePanel buy works on SOL.
- QuickTradePanel sell fails quickly with `request timed out`.
- Failure is faster than on-chain timeout, so the likely issue is in UI -> messaging -> background -> executor handoff or a local timeout guard.

## Falsifiable Hypotheses

1. Messaging layer timeout is firing before background sell finishes, and only sell path is affected.
2. Background receives `tx:sellWithReceiptAuto` but exits early on SOL-specific validation or route refresh before submit.
3. A recent change broke the sell input shape for SOL, causing `sellWithReceiptAuto` to reject immediately while buy input remains valid.
4. Background/service worker reload mismatch means UI and background message contracts are out of sync, producing fast local timeout/error.
5. Existing sell instrumentation is present but not active in the loaded extension build, so repro after reload is needed before code changes.

## Evidence Plan

- Inspect `App.tsx` sell call site, `utils/messaging.ts`, and `background.ts` `tx:sellWithReceiptAuto`.
- Start debug server and collect `pre-fix` logs using existing sell instrumentation if sufficient.
- If current logs are insufficient, add minimal instrumentation only.
- Confirm the exact failing stage before any logic fix.
