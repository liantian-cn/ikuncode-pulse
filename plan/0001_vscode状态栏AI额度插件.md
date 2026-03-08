# VS Code 状态栏 AI 额度插件

## 概要

- 做一个 TypeScript 的 VS Code 扩展，在右下角状态栏显示剩余额度和本次会话累计花费。
- 金额口径固定为人民币，换算规则是 `quota / 500000`。
- 剩余额度、总额度保留 2 位小数；最近一分钟花费和本次会话花费保留 6 位小数。
- 扩展激活后立即刷新余额，并按 60 秒周期轮询余额与最近使用情况。

## 功能设计

- 状态栏平时显示：`¥剩余额度 · 本次 ¥会话累计`。
- 每 60 秒查询一次最近窗口花费；如果检测到新增花费：
  - 状态栏做一个短暂小动画
  - 弹出简短提示
  - 把这次花费累加进当前 VS Code 会话累计
- 鼠标悬浮时的 tooltip 显示：
  - 账户信息
  - 剩余额度、已用额度、总额度
  - 最近一分钟花费
  - 本次会话累计花费
  - 上次刷新时间
  - 最近错误信息（如果有）
- 如果填写了站点名称和站点地址，在 tooltip 底部显示一个可点击链接。

## 设置项

- 必填：
  - `ikuncode-pulse.baseApiUrl`
  - `ikuncode-pulse.userId`
  - `ikuncode-pulse.accessToken`
- 选填：
  - `ikuncode-pulse.siteName`
  - `ikuncode-pulse.siteUrl`
  - `ikuncode-pulse.refreshSeconds`
  - `ikuncode-pulse.enableAnimation`

## 交互

- 点击状态栏后弹出一个小命令菜单：
  - 立即刷新
  - 打开设置
  - 打开用户设置 JSON
  - 复制当前摘要
  - 打开站点（已配置时）

## 容错与验证

- 缺少必填配置时，不发请求，状态栏提示去设置。
- 请求失败时保留上一次成功数据显示，并在 tooltip 里显示错误。
- 对轮询增加串行保护，避免重复请求重叠。
- 通过 TypeScript 编译验证扩展元数据和主逻辑可构建。
