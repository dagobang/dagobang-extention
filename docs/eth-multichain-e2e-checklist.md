# ETH 多链改造 E2E 回归清单

## 0. 准备项
- 在 `constants/contracts/address.ts` 填入 ETH 的 `DagobangRouter` 地址。
- 设置页选择 `Ethereum`，填入可用 `rpcUrls`，保存后刷新页面。
- 准备至少 1 个有 ETH 的钱包地址（建议再准备 1 个子钱包）。

## 1. 配置与 UI
- 打开设置页，确认链选择支持 `Ethereum` 与 `BSC` 切换。
- 切换到 `Ethereum` 后，`Trade/Gas/Network` 配置均独立保存，不影响 BSC。
- 在限价面板确认原生币符号显示为 `ETH`，交易哈希链接跳转 `etherscan`。

## 2. 基础链路
- `tx:buy`（普通模式）提交成功，状态广播 `bg:tradeSubmitted/bg:tradeSuccess` 正常。
- `tx:sell`（普通模式）提交成功，allowance 不足时能自动触发 approve 修复并重试。
- `tx:buyWithReceiptAuto` 与 `tx:sellWithReceiptAuto` 能正确拿到 receipt 成功状态。

## 3. 多跳与路由
- 目标 token 直接 `WETH -> token` 路径可成交。
- 目标 token 需桥接（如 `WETH -> USDC -> token`）时，两段 desc 正常构建并成交。
- Turbo 与 Default 两种模式都可用，错误信息中的原生币符号为当前链符号。

## 4. 广播与 RPC
- 公共 RPC 广播成功（无 bloXroute）。
- 配置 bloXroute 后，私有交易方法按 ETH 路由（非 BSC 方法名）。
- 开启优先费后 Bundle 广播可工作；不可用时能回退到 raw 广播并给出可读错误。

## 5. 非交易功能联动
- Telegram 快捷买卖文案中的原生币符号随链变化（ETH/BSC）。
- Background 中 token brief 的 chain code 映射正确（eth/bsc）。
- 价格服务可在 ETH 返回有效价格（USDT/USDC/WETH 路径至少命中一种）。

## 6. 回归 BSC
- 切回 BSC 后，原有买卖、限价单、自动策略不回归。
- BSC 广播行为与改造前一致（包括 anti-mev 与 bloXroute 开关）。

## 7. 兼容字段回归（本次新增）
- `tx:buy` 仅传旧字段 `bnbAmountWei` 仍可成交。
- `tx:buy` 传新字段 `nativeAmountWei` 时优先使用新字段。
- `priorityFeeNative` 与旧字段 `priorityFeeBnb` 二选一都可生效。
