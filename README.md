# IkunCode Pulse

在 VS Code 右下角状态栏显示 AI 余额、本次会话花费，以及最近一个轮询窗口的使用情况。

## 功能

- 状态栏显示剩余额度和本次会话累计花费
- 默认每 60 秒自动刷新
- 自动刷新使用轻刷新：每轮只请求 1 次接口
- 点击状态栏使用重刷新：每轮请求 3 次接口并同步精确数值
- 检测到新增花费时会短暂高亮状态栏并显示金额，高亮持续约 6 秒
- 鼠标悬浮可查看详细 tooltip
- 点击状态栏会直接刷新
- tooltip 会显示今日花费、最近一次刷新耗时、当前轮询间隔、连续失败次数

## 失败退避

- 第 1 次失败：下次仍按正常轮询间隔刷新
- 连续失败后：每次额外增加 60 秒
- 最长退避到 5 分钟
- 一旦成功：恢复到正常轮询间隔

## 配置

建议把配置写进 VS Code 的用户设置 JSON。

```json
{
  "ikuncode-pulse.baseApiUrl": "https://api.ikuncode.cc/api/",
  "ikuncode-pulse.userId": "13167",
  "ikuncode-pulse.accessToken": "your-token",
  "ikuncode-pulse.siteName": "IkunCode",
  "ikuncode-pulse.siteUrl": "https://api.ikuncode.cc/"
}
```

## 集中修改默认站点

- 如果以后你要换别家 token 商，优先改根目录的 `branding.json`。
- 这里集中放了插件显示名、默认 `baseApiUrl`、默认站点名称、默认站点地址。
- 构建时会自动把这些值同步到 `package.json`，避免你到处找地方改。

## 金额换算

- 接口返回的 `quota` 按 `quota / 500000 = 人民币` 计算。
- 剩余额度、总额度显示 2 位小数。
- 本次刷新花费、本次会话花费显示 6 位小数。

## GitHub Releases 自动打包

项目已自带 GitHub Actions 工作流：`.github/workflows/release.yml`

触发方式：

- 推送形如 `v0.0.1` 的标签
- 或在 GitHub Actions 页面手动运行

工作流会自动：

- 安装依赖
- 执行 `npm run package`
- 创建或更新 GitHub Release
- 把生成的 `.vsix` 上传到 Release 附件里

常用发布步骤：

```bash
git tag v0.0.1
git push origin v0.0.1
```

## 开发

```bash
npm run compile
```

在 VS Code 中打开项目后，可以直接按 `F5` 启动扩展开发宿主。

项目已自带这些调试文件：

- `.vscode/launch.json`：启动扩展调试
- `.vscode/tasks.json`：调试前自动执行 `npm run compile`

如果你想一边改一边自动编译，也可以手动运行：

```bash
npm run watch
```
