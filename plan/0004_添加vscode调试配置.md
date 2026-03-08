# 添加 VS Code 调试配置

## 目标

- 让项目在 VS Code 里按 `F5` 就能启动扩展开发宿主。
- 调试前自动编译 TypeScript，避免手动先跑一遍构建。
- 保留一个监视任务，方便边改边编译。

## 改动

- 新增 `.vscode/launch.json`
- 新增 `.vscode/tasks.json`
- README 补充本地调试说明

## 验证

- `npm run compile` 能通过
- `launch.json` 的预启动任务能命中 `npm: compile`
- 在 VS Code 中按 `F5` 时会启动 Extension Development Host
