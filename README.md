# Dagobang Extension

Dagobang 是一款面向 Meme 交易的非托管浏览器插件，基于 WXT 构建。它在你常用的看盘/挂单页面上以悬浮窗形式提供交易能力，并通过静默签名与多节点广播提升高频交易的执行效率。

## 核心能力

### 🚀 高频执行
- **静默签名 (Silent Signing)**：在你解锁钱包并授权后，后续交易可在后台完成签名与广播，减少频繁弹窗打断。
- **多节点广播 / RPC 竞速**：同一笔交易可同时向多个 RPC 或广播服务提交，以更快被链上接受为准；支持识别本次提交使用的服务来源并回显。
- **Gas 预设**：内置多档 Gas 档位，适配不同拥堵程度。

### 🧾 自动化交易
- **限价挂单（买入/卖出）**：支持创建限价单，价格触达触发条件后自动执行并记录结果。
- **高级自动卖出**：支持多档止盈/止损等规则组合，减少重复操作。

### 🛡️ 安全与隐私
- **非托管密钥**：助记词/私钥加密后存储在浏览器本地持久化存储中，不上传服务器。
- **内存级解锁态**：解锁态保存在浏览器会话存储中，随会话结束而清理（可选自动锁定）。
- **保护/隐私 RPC**：支持配置保护 RPC（例如付费或自建节点）以降低公共节点限流与可观测性风险。

## 目录结构（同步当前代码）

```
dagobang-extention/
├── entrypoints/
│   ├── background.ts                 # 后台入口（消息分发）
│   ├── background/limitOrderScanner.ts  # 限价单扫描/触发
│   ├── content.ts                    # 页面脚本（注入悬浮窗容器）
│   ├── injected.ts                   # 注入脚本
│   ├── popup/                        # 插件弹窗（React）
│   └── content-ui/                   # 悬浮窗 UI（React）
├── services/                         # 核心业务逻辑
│   ├── wallet.ts                     # 钱包创建/导入/解锁/签名
│   ├── trade.ts                      # 交易构建与发送
│   ├── rpc.ts                        # RPC/广播
│   ├── autoTrade.ts                  # 自动化交易入口
│   ├── limitOrders/                  # 限价单与高级自动卖出
│   ├── token/                        # 平台/代币适配
│   └── api/                          # 外部接口封装
├── utils/                            # 通用工具（crypto/i18n/messaging/format/...）
├── hooks/                            # React hooks（TokenAPI 等）
├── constants/                        # 常量（链/合约/ABI/代币列表等）
├── types/                            # 类型定义
├── locales/                          # i18n 文案
├── public/                           # 静态资源
└── wxt.config.ts                     # WXT 配置
```

## 开发与构建

### 环境要求
- Node.js >= 18
- npm

### 安装依赖
```bash
npm install
```

### 开发模式
```bash
npm run dev
```

### 类型检查
```bash
npm run compile
```

### 生产构建
```bash
npm run build
```
构建产物输出到 `.output/chrome-mv3/`，可直接在 Chrome/Edge 以“加载已解压的扩展程序”方式加载。

### 打包
```bash
npm run zip
```
构建产物输出到 `.output/dagobang-extention-0.1.2-chrome.zip`，可解压后直接在 Chrome/Edge 以“加载已解压的扩展程序”方式加载。

## 配置说明
- 插件的链、RPC 列表、保护 RPC、Anti-MEV、滑点、deadline、Gas 档位等均在 Popup 的 Settings 页面配置并存储在浏览器本地。
- 如需使用第三方广播服务的鉴权信息，请仅通过本地设置提供，不要把任何密钥提交到仓库。

## 隐私节点（Protect RPC）配置指南

本插件把 RPC 分成两类：
- `RPC URLs`：主要用于读链/报价/查询等请求（可以放多条，容忍偶发限流/抖动）。
- `Protected RPC URLs`：主要用于广播交易（建议只放少量高质量节点，用于“竞速广播”）。由于只承担交易提交这一小段流量，大多数情况下注册并使用服务商的免费计划就够用。

当 `Anti-MEV` 开启且 `Protected RPC URLs` 为空时，交易广播会直接失败（插件会提示检查 Anti-MEV 设置）。因此如果你要开启 Anti-MEV，请务必配置至少 1 条保护 RPC（建议 3–4 条）。

### 1) 在 Popup 里配置 Protect RPC
1. 打开插件 Popup → `Settings`。
2. 在 `Network` 区域配置：
   - `RPC URLs`：每行一个 RPC URL。
   - 打开 `Anti-MEV`。
   - `Protected RPC URLs`：每行一个保护 RPC URL（建议 3–4 条，不同服务商混搭）。
3. 点击 `保存修改`。

### 2) 可选：配置 bloXroute 私有广播
如果你有 bloXroute 账号，可以在 Popup → `Settings` → `API 密钥` 中填写：
- `Bloxroute Auth Header`：用于 bloXroute 的 `Authorization` 头（仅保存在本地）。

启用后，交易会尝试同时走 bloXroute 私有通道与保护 RPC 竞速广播，以更快返回 `txHash` 为准。

### 3) 选型建议（针对香港/新加坡 VPN）
- `Protected RPC URLs` 建议以新加坡（SG）为主（与你 VPN 出口一致），必要时补一条香港（HK）节点做容灾。
- 组合思路：1 个稳定大厂节点 + 1 个交易向节点 + 1–2 个多地域付费节点。
- 数量建议：3–4 条足够；太多更容易触发限流/风控，维护成本也更高。

## 推荐 Protect RPC（示例模板）

下面给的是“可直接照抄的模板”，请把其中的 `YOUR_KEY` / `YOUR_TOKEN` 替换成你自己的密钥；不要把真实 Key 写进仓库或截图公开。
如果你只把 Protect RPC 用作“提交交易”，通常不需要购买高配套餐，免费计划一般就能满足需求（除非你有非常高频的自动化交易/批量挂单）。

### 主力（建议至少 2 条）
- NodeReal（SG/HK 任选其一，偏稳定托底）
  - `https://bsc-mainnet.nodereal.io/v1/YOUR_KEY`
- Chainstack（Singapore / Hong Kong（如可选），偏稳定，适合作为主力或强冗余）
  - `https://bsc-mainnet.core.chainstack.com/YOUR_KEY`（示例格式，以控制台实际为准）

### 补充（稳定性加 1–2 条）
- Blockrazor（交易向节点，建议作为补充而不是唯一依赖）
  - `https://bsc.blockrazor.xyz/YOUR_KEY`
- GetBlock（Singapore，可选区域，适合补充）
  - `https://go.getblock.io/YOUR_KEY`

### 一套可用的 Protected RPC 样例（4 条）
```
https://bsc-mainnet.nodereal.io/v1/YOUR_KEY
https://bsc-mainnet.core.chainstack.com/YOUR_KEY
https://bsc.blockrazor.xyz/YOUR_KEY
https://go.getblock.asia/YOUR_KEY
```

## 安全性说明
- **加密落盘**：钱包数据落盘前经由口令派生与对称加密处理。
- **零后端托管**：交易直接与链上交互与广播，不托管资金。
- **静默签名的边界**：静默签名用更少交互换取更快执行。只建议在设备环境可信、并且你理解授权含义的前提下使用。

## License
GPLv3，见 LICENSE。
