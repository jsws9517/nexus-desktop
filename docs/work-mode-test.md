# work 模式测试指南

WorkBuddy 工作模式（P2 的 A 级实现，见 `docs/p2-sub-agent.md`）＝
LLM 规划 → per-tab worker 内确定性 Skill（`sheet.read` / `sheet.analyze` / `bi.chart`）→
Artifact envelope 经 `tool_result` 事件流出 → renderer 内联卡片 + 导出。

本文按测试层给出现有命令与手工验收步骤。

## Tier 0 — 确定性自动化（不需要 LLM，进 CI）

| 命令 | 覆盖 | 说明 |
|---|---|---|
| `npm run test:unit` | `test/artifact.test.mjs` + `test/skills.test.mjs` + `test/renderer-artifacts.test.mjs` 等 | envelope 校验/往返、CSV 与 XLSX 解析（尺寸/行数上限）、列统计、Vega-Lite 白名单 + `compile()`、renderer 卡片 DOM 与导出参数 |
| `npm run test:smoke` | `scripts/smoke-test.mjs` | 起 `dist/agent-worker.js`，经 RPC 直调 skill：注册表存在性、`sheet.read` 正常、`bi.chart` 编译 + 白名单拒绝 |
| `npm run check:i18n` | `scripts/check-i18n.mjs` | 产物 UI 词条（artifactExportCsv 等）与 index.html 用量一致 |

看输出：`npm run test:unit` 末尾应为 `pass N / fail 0`；smoke 末尾应为 `SMOKE TEST: ALL PASS`。

## Tier 1 — LLM 全链路（需要真实 provider，不进 CI）

命令：`npm run build && node scripts/work-mode-test.mjs`（或 `npm run test:work`）

`scripts/work-mode-test.mjs` 起 worker，提交 work 提示词（读取 `test/fixtures/sales.csv` → `sheet.analyze` → `bi.chart`），断言：

1. 事件流出现 `tool_call_start`，name ∈ {sheet.read, sheet.analyze, bi.chart}；
2. 对应 `tool_result` 的 `content` 经 `parseArtifactContent()` 得到 envelope 且非 error；
3. `turn_end` 正常；
4. permission 询问数为 0（fixture 在 worker cwd 允许根内，不弹权限）。

依赖：`~/.nexus/config.json` 已配置可用 provider（与 `npm run test:chat` 相同）。
模型若不按提示词调用工具，测试会打印完整工具序列后失败——此时换更顺从的模型或调整提示词重试。

## Tier 2 — 桌面手动验收（Electron）

步骤：

1. `npm start` 启动桌面端；
2. 新建会话（＋ 或 `/new`）；
3. 输入 work 提示词（可用下例，或用任意待分析文件 + 相对路径）：

   ```
   请读取 test/fixtures/sales.csv，用 sheet.analyze 统计 amount 的 sum 和 mean，
   然后用 bi.chart 画 amount by month 的柱状图，最后一句话总结。
   ```

4. 检查点：

| 检查点 | 预期 |
|---|---|
| 消息流出现 sheet 内联卡片 | 表头 month/amount/region，数字单元格右对齐（`.num`），底部 meta 显示 `6 × 3` 与来源路径 |
| 消息流出现 chart 内联卡片 | vega 图真实渲染（不是 `<summary>chart</summary>` 折叠项）；DevTools Console 无 CSP/脚本加载报错（验证 `static/vega*.js` 生效） |
| 导出 CSV | 点「导出 CSV」弹出保存对话框，确认后 explorer 定位到文件 |
| 导出 PNG | 点「导出 PNG」同样走保存对话框 + 定位 |
| 历史重渲染 | 重新打开窗口并进入该会话，历史行再次出现卡片（`addToolResultBlock` 从持久化 `tool_result` 重建） |

失败排查：卡片变成折叠 `<details>` 说明 `window.vegaEmbed` 未加载（看 Console 报错）；
card 一直是文字工具块说明 envelope 未被 `tryMountArtifact` 识别（对照 Tier 1 事件流确认 skill 是否真的返回了 envelope）。

## 各层覆盖关系

- Tier 0：验证"确定性代码"半边（协议/解析/渲染纯逻辑）。
- Tier 1：验证"LLM 意图 → 工具 → envelope 事件"闭环（无 UI）。
- Tier 2：验证"事件 → 渲染 → 导出 → 重载"全链路（含 UI 与 IPC）。
- Tier 3：在 Tier 0 基础上把 renderer 卡片与导出参数自动断言，缩小 Tier 2 的手工范围。