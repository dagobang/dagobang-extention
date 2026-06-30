# [OPEN] sol-limit-not-trigger

## Symptom
- SOL 挂单在 UI 已显示现市值越过触发价后，状态仍停留在 `等待触发`，没有执行。

## Scope
- 平台：当前用户反馈来自 `gmgn` 的 SOL 页面
- 影响：SOL 挂单扫描/触发/执行链路

## Hypotheses
1. 扫描器拿到的运行时价格和 UI 展示价格来源不同，导致后台判断未命中。
2. 挂单已被扫描到，但因为钱包状态或 `fromAddress` 校验未通过，执行前被跳过。
3. 挂单命中后进入执行器，但在余额解析或发送交易阶段失败。
4. 该挂单未进入本轮扫描候选集，可能被 `chainId`、`tokenAddress`、`status` 或 `retryAtMs` 条件过滤掉。

## Evidence Plan
- 在扫描器记录：候选单、读取到的价格、命中判断、跳过原因。
- 在执行器记录：进入执行、余额解析、下单提交、失败原因。
- 对照用户复现前后的日志，确认哪条假设成立。

## Status
- 2026-06-30: 初始化调试会话，等待添加运行时埋点。
- 2026-06-30: `pre-fix` 日志确认扫描器能读到挂单，但被 `WalletService.getStatus()` 提前拦截，表现为 `locked: true, address: null`。
- 2026-06-30: 第一次修复后，`post-fix` 日志确认 `SOL` 钱包状态已能变为未锁定，但扫描器继续卡在价格读取，稳定报错 `Solana RPC price requires token info price fallback`。
- 2026-06-30: 已撤回“后台直接调 GMGN API 兜底价格”的临时尝试；后续只沿着后台可用的 `RPC/quote` 价格来源继续修。
