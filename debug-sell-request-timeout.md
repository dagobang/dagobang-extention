# Debug Session: sell-request-timeout
- **Status**: [OPEN]
- **Issue**: 快捷面板/交易面板卖出经常出现 `request timeout`
- **Debug Server**: http://127.0.0.1:7780/event
- **Log File**: .dbg/trae-debug-log-sell-request-timeout.ndjson

## Reproduction Steps
1. 打开当前代币的交易面板
2. 发起一次卖出
3. 观察是否出现 `request timeout`
4. 如失败，记录是否有提交中 toast、是否有链上 txHash、是否最终上链

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | `browser.runtime.sendMessage` 到 background 的请求本身超时，后台 handler 没能在超时窗口内返回 | High | Low | Pending |
| B | 卖出前的余额解析/报价/构建在 UI 或 background 内阻塞过久，导致 `call()` 先超时 | High | Low | Pending |
| C | 卖出实际上已提交，但 UI 仍在等待 receipt 或更深层 Promise，最终被统一包装成 `request timeout` | High | Med | Pending |
| D | `SOL` 卖出路径的某个预热/路由/账户查询偶发卡住，尤其是 `turbo` 或特定 submit channel 下 | Med | Med | Pending |
| E | 最近关于 holding/price 的轮询改动与卖出并发，导致 UI 线程或消息回流竞争，放大了超时概率 | Med | Low | Pending |

## Log Evidence
[Pending]

## Verification Conclusion
[Pending]
