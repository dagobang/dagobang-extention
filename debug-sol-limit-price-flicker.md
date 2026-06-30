[OPEN] SOL 挂单现价闪烁且数值偏低

## Symptoms

- SOL 挂单执行已恢复。
- 挂单面板中的“现价”显示错误，真实价格约为 `0.1`，UI 会在 `0.1` 与 `0.074` 左右来回闪动。
- 需要确认 UI 展示价、后台扫描价、触发比较价是否混用了不同来源。

## Scope

- 仅聚焦 SOL limit order 的现价显示与触发比较。
- 在拿到运行时证据前，不修改业务逻辑。

## Hypotheses

1. UI 现价混用了页面价与后台 quote 价，导致数值闪烁。
2. 新增 SOL quote resolver 命中了错误 source/base，后台报价偏低。
3. 挂单面板现价与 scanner 比较价共享状态时被覆盖。
4. WSOL/USD 基准或 decimals/source 解析错误，导致后台 quote 偏差。

## Plan

1. 启动独立 debug server。
2. 给 limit order UI 与 scanner 补最小埋点，记录 price source / source alias / resolved price / trigger compare。
3. 让用户复现一次。
4. 基于日志排除假设后再做最小修复。

## Evidence

- 页面 `tokenPrice` 持续在 `0.105~0.106` 左右。
- scanner 的 `scanStatus` 持续回写 `0.077~0.078`。
- UI 会先收到页面价，再被 `scanStatus` 覆盖，因此出现闪烁。
- `token -> WSOL` 报价约 `0.00140 SOL`，推导接近页面价；真正异常的是 `WSOL/USD` 基准仅有 `55.82`。

## Fix In Progress

- 已先做最小显示修复：当前页面 token 有有效 `tokenPrice` 时，不再让 `scanStatus` 覆盖该 token 的面板现价。
- 后续若用户继续反馈后台触发价仍偏低，再单独修 `WSOL/USD` 后台 quote 基准。
