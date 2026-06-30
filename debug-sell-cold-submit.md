# Debug: sell-cold-submit

Status: [OPEN]

## Symptom

- SOL turbo 卖出首笔提交偶发约 `400ms+`
- 同一轮后续卖出热样本可降到约 `67ms`

## Scope

- Chain: `SOL`
- Route focus: `pumpfun` / `pumpswap`
- Stage focus: submit path before broadcast

## Hypotheses

1. 卖出首笔慢主要卡在 `bonding curve state` 冷读取，后续热命中后恢复正常。
2. 卖出首笔慢主要卡在 `blockhash` 冷获取；热 `blockhash` 命中后提交显著变快。
3. 卖出路径存在额外的账户检查或卖出专属前置逻辑，导致比买入更容易出现冷启动开销。
4. 提交日志中的高 `submitElapsedMs` 不是广播慢，而是 adapter build 内某一步冷跑叠加造成。
5. 同轮连续卖出里存在部分样本先触发冷路径、后续样本复用同一批热缓存，因此形成 `473ms -> 67ms` 的分层现象。

## Evidence

- Confirmed:
  - `state` 冷读取会直接吃掉约 `201ms`
  - `creatorVault` 在首卖冷样本中也会再吃掉约 `202ms`
  - `blockhash` 在这笔慢样本里不是主因，已是热命中 `0ms`
  - 广播不是主因，慢样本广播仅约 `64ms`
  - `50%` 连点卖出问题的根因不是百分比公式，而是第二次点击仍按旧余额计算
  - 上一版前端“在途卖出预留”在 `call(tx:sellWithReceiptAuto)` 返回后立刻释放，未覆盖余额刷新滞后的窗口
- Key log slices:
  - `1782483313466` `pumpfun/adapter.ts:buildLegacyInstruction:stateDone` -> `elapsedMs: 201`
  - `1782483313668` `pumpfun/adapter.ts:buildLegacyInstruction:creatorVaultDone` -> `elapsedMs: 403`
  - `1782483313669` `pumpfun/adapter.ts:buildLegacyInstruction:blockhashDone` -> `elapsedMs: 0`, `totalElapsedMs: 404`
  - `1782483313670` `solanaTradeExecutor.ts:executeRequest:adapterBuildDone` -> `elapsedMs: 405`
  - `1782483313735` `broadcast.ts:sendSignedTransaction:rpcDone` -> `totalElapsedMs: 64`
  - `1782483314429` `App.tsx:sellRequestDone` -> `submitElapsedMs: 473`
  - 对照热样本：
    - `1782483313888` `stateDone` -> `0ms`
    - `1782483313889` `creatorVaultDone` -> `1ms`
    - `1782483313889` `blockhashDone` -> `0ms`, `totalElapsedMs: 1`
    - `1782483313890` `adapterBuildDone` -> `2ms`
    - `1782483314604` `sellRequestDone` -> `submitElapsedMs: 67`
  - `50%` 连点相关：
    - `1782402089095` `App.tsx:sellPrepareDone` -> `percentBps: 5000`, `tokenAmountWei: 353018509406`
    - 若第二次点击发生在余额源更新前，仍会再次按接近旧余额计算
    - 旧实现中 `pending sell reservation` 在请求返回后的 `finally` 中立即释放，导致保护窗口失效

## Decision

- H1 Confirmed: 卖出首笔慢确实包含 `bonding curve state` 冷读取。
- H2 Rejected: 这批慢卖样本里 `blockhash` 不是主因。
- H3 Partially confirmed: 卖出并没有额外 ATA 冷检查，但有卖出同样依赖的 `creatorVault` 冷读取。
- H4 Confirmed: 高 `submitElapsedMs` 主要发生在 adapter build 内，而不是广播阶段。
- H5 Confirmed: 同轮先冷后热，形成 `473ms -> 67ms` 的分层，说明缓存命中差异是主原因。
- H6 Confirmed: `50%` 连点卖出问题是“余额刷新滞后窗口”问题，不是百分比算法错误。
