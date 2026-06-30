# [OPEN] sol-toast-balance

## Symptoms
- SOL 快捷面板卖出预估 SOL 数值明显偏小
- SOL 买入/卖出后提示窗长时间停留在“上链中”
- 前几轮静态修复后，用户反馈“都没变化”

## Expected
- 卖出预估应与页面/站点实际可卖出 SOL 接近
- 交易提交后应先出现提交提示，再收到完成提示与耗时

## Hypotheses
1. `tokenPriceUsd` 在 SOL 下来源错误，导致卖出预估缩小约 1000 倍。
2. `tradeBasePriceUsd` 在 SOL 下取值错误或未刷新，导致 USD 转 SOL 失真。
3. 后台未广播 `bg:tradeSuccess`，只有 `bg:tradeSubmitted`。
4. 内容页收到 `bg:tradeSuccess`，但因 `txHash/tokenAddress` 不匹配未正确替换 toast。

## Plan
1. 启动 Debug Server
2. 仅加入埋点，不改业务逻辑
3. 抓取一次 SOL 卖出预估和一笔 SOL 买/卖的运行日志
4. 基于证据判定根因后再做最小修复

## Evidence
- `pre-fix` 日志第 1-4 行显示：
  - 后台已广播 `bg:tradeSubmitted`（buy/sell 各一条）
  - 前台已收到 `bg:tradeSubmitted`（buy/sell 各一条）
  - 未出现任何 `bg:tradeSuccess`
- 第二轮 `SellSection.tsx:preview` 日志显示：
  - `tokenBalanceAmount ≈ 3520.9187`
  - `tokenPriceUsd ≈ 2.052775e-06`
  - `baseTokenPriceUsd ≈ 73.2422`
  - `fallbackPreviewBaseAmount ≈ 9.868e-05`
  - 说明预估错误来自 `tokenPriceUsd` 本身，不是格式化问题
- 第二轮 `solanaTradeExecutor.ts:*ConfirmStart` 已出现，但 `*ConfirmDone` 未出现：
  - 说明确认流程已进入 `confirmSignature()`
  - 但没有正常返回，后台因此没有继续广播 `bg:tradeSuccess`
- 第二轮前端埋点里 `tokenSymbol === null`
  - 说明 toast 中代币名称缺失是实际运行态问题，不是用户误报

## Hypothesis Status
| ID | Hypothesis | Status | Evidence Summary |
|----|------------|--------|------------------|
| A | `tokenPriceUsd` 在 SOL 下来源错误，导致卖出预估缩小约 1000 倍 | ✅ Confirmed | `SellSection.tsx:preview` 已记录错误单价，导致 100% 预估缩小约 1000 倍 |
| B | `tradeBasePriceUsd` 在 SOL 下取值错误或未刷新 | ❌ Rejected | 同一条日志中 `baseTokenPriceUsd ≈ 73.2422` 与预期量级一致，异常来自 token 单价 |
| C | 后台未广播 `bg:tradeSuccess`，只有 `bg:tradeSubmitted` | ✅ Confirmed | `confirmStart` 有、`confirmDone` 无，`background.ts` 仅出现 submitted，无 success |
| D | 内容页收到 `bg:tradeSuccess`，但未正确替换 toast | ❌ Rejected | 若前台收到 success，日志应出现 `ui received tradeSuccess`；当前无此记录 |

## Fixes Applied
1. `App.tsx`
   - GMGN Solana 页面新增持仓侧单价/符号兜底
   - 卖出预估与 toast 文案改为统一使用有效价格与有效 symbol
2. `hooks/TokenAPI.ts`
   - `gmgn + solana` 价格查询改为优先走 GMGN candle price，再回退到 `tokenInfo`
3. `services/chain/solana/rpc.ts`
   - `confirmSignature()` 改为 `confirmTransaction` 与 `waitForSignature` 并行兜底，避免单一路径悬挂
4. `services/chain/solana/solanaTradeExecutor.ts`
   - 将 timeout 显式传入 Solana 确认流程

## Verification
- `npm run build` 已通过
- 下一步需要用户执行 `post-fix` 复现，确认：
  - 卖出 100% 预估恢复到正确量级
  - toast 出现已提交 -> 成功的切换，并自动关闭
  - toast 与面板里代币名称恢复显示
