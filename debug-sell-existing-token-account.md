# Debug Session: sell-existing-token-account

- Status: [OPEN]
- Created: 2026-06-29
- Scope:
  - PumpSwap migrated outer-market sell sometimes fails on first click with `PumpSwap sell requires existing token account`
  - Retrying sell shortly after often succeeds without any code or wallet change
- Guardrails:
  - No business-logic changes before fresh evidence is re-read
  - Treat this as an ATA/account-state timing problem until logs prove a different root cause

## Hypotheses

1. The first sell attempt reads a stale ATA-existence cache entry or a stale chain snapshot before the user token ATA becomes visible at the chosen commitment.
2. The token account exists, but the adapter derives the wrong ATA on the first attempt because the selected token program or mint differs across warm/build phases.
3. The user is clicking sell immediately after buy, and local UI state advances earlier than the token ATA/account visibility used by PumpSwap sell build.
4. Prewarm and build use inconsistent account lookup paths, so the first attempt misses a just-created ATA while the second attempt hits a fresher read.

## Evidence To Collect

- Current PumpSwap sell builder path for ATA derivation and existence checks
- ATA cache TTL / commitment level / batch lookup behavior
- Latest runtime logs around the failing first-sell sample

## Next Step

- Re-read PumpSwap sell ATA lookup code and recent logs before deciding whether the next change is instrumentation or a minimal fix.

## Evidence

- Current PumpSwap sell path throws locally before submit when `userBaseAtaExists === false`.
- ATA existence lookups were using a shared cache with a long positive TTL and the same cache path for negative results.
- Prewarm already touched ATA existence, but it could still leave a stale `false` shortly before a rapid post-buy sell attempt.

## Minimal Fix Applied

- `packages/solana-dex-core/src/protocols/pumpswap/adapter.ts`
  - keep ATA existence prewarm, but switch prewarm account existence reads to `processed`.
  - shorten `false` ATA cache lifetime to avoid stale "missing" results after a rapid buy.
  - on sell-side missing token ATA, perform one fresh `processed` recheck that bypasses cache before throwing.

## Validation

- `GetDiagnostics`: clean
- `npm run compile`: passed
