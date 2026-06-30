# [OPEN] pump-direct-adapter

## Symptoms
- Pump 内盘买入和卖出都失败
- 页面报错 `No direct Solana adapter available for platform:pump.fun`
- 之前还出现过 `Jupiter quote failed: 429`

## Expected
- Pump 内盘交易应优先命中 `pumpfun` 或 `pumpswap` 直连适配器
- 不应在 `pump/pump.fun` 场景 silent fallback 到 `Jupiter`

## Hypotheses
1. `tokenInfo.launchpad_platform` 虽然是 `pump.fun`，但传入执行器后的关键字段不完整，导致 `pumpfun/pumpswap` 都判断 `supportsTrade=false`。
2. 该 token 实际已经从 bonding curve 切到 PumpSwap，但 `pumpfun` 判断为 complete、`pumpswap` 又因池子上下文读取失败而一起失配。
3. 买卖请求里的 `inputMint/outputMint/baseTokenAddress` 有一项与直连协议预期不一致，导致 pair check 失败。
4. GMGN 页面 token info 与真实链上状态不一致，planner 收到的 platform 是 `pump.fun`，但链上已不是 Pump 系列可直连状态。

## Plan
1. 启动新的 Debug Server 会话
2. 只加埋点，不改业务逻辑
3. 请用户复现一次买入和卖出失败
4. 读取日志确认是哪一个适配器、哪一步判断失败

## Evidence
- `solanaTradeExecutor.ts:buildTradeRequest` 日志显示：
  - `platform = "Pump.fun"`
  - `inputMint/outputMint` 对买卖方向都正确
  - 说明不是交易方向或 mint 传参错误
- `pumpfun/adapter.ts:supportsTrade` 与 `pumpswap/adapter.ts:supportsTrade` 都记录到同样错误：
  - `error = "Buffer is not defined"`
  - 且买入、卖出两条路径一致
  - 说明不是某个协议状态不支持，而是浏览器运行时缺少 `Buffer`
- `planner.ts:planSolanaTrade` 最终记录：
  - `preferredSource = "pumpfun"`
  - `forceDirectOnly = true`
  - 但因为两个直连适配器都被运行时错误打断，最终触发 `planner direct-only failed`

## Hypothesis Status
| ID | Hypothesis | Status | Evidence Summary |
|----|------------|--------|------------------|
| 1 | `tokenInfo` 关键字段不完整导致直连适配器失配 | ❌ Rejected | `platform/inputMint/outputMint` 都正确进入执行器，失败发生在适配器内部运行时 |
| 2 | token 已从 bonding curve 切换，导致 `pumpfun` 不支持 | ❌ Rejected | `pumpfun` 还没走到 curve complete 判断就先抛 `Buffer is not defined` |
| 3 | `inputMint/outputMint/baseTokenAddress` 传错导致 pair check 失败 | ❌ Rejected | 买卖两条链路的 mint pair 与预期一致 |
| 4 | 浏览器运行时缺少 `Buffer`，导致 `pumpfun/pumpswap` 都被误判为不支持 | ✅ Confirmed | 两个适配器的日志都明确记录同一运行时错误 |
