# Nexus Desktop 开发需求清单 / Development Requirements

> 来源：桌面端架构评审（2026-08-19）。每项统一字段：编号 / 优先级 / 状态 / 问题 / 方案 / 验收。
> 状态：🟡 待做 · 🔵 进行中 · 🟢 已完成
> Source: Desktop architecture review (2026-08-19). Each item: ID / Priority / Status / Problem / Solution / Acceptance.

## 优先级说明 / Priority Legend

- **P0** 发布质量：影响其他用户可用性或发布整洁度，优先做
- **P1** 性能/安全/健壮性：量级中等，随版本迭代推进
- **P2** 架构/工程/体验：可持续演进，按阶段落地

---

## A. 正确性 / 发布质量 · Correctness & Release Quality

### A1. 硬编码日志路径清理 / Hardcoded Log Path Cleanup · [P0] 🟢

**问题 / Problem**
- `src/main/index.ts`、`src/main/worker-host.ts`、`src/agent-worker.ts` 写死 `C:/Users/pgw/AppData/Local/Temp/opencode/`（作者本人 Windows 临时目录）。
- 字符串会编译进 `dist/**/*` 并随 `app.asar` 打包（package.json `build.files`）；其他用户/CI 机器上该目录不存在 → 被 `try{}catch{}` 吞掉 → 日志静默丢失。
- 硬编码作者机器用户名泄露进开源仓库源码；且为绝对 Windows 路径，macOS/Linux 无效。

**方案 / Solution**
1. 新建 `src/shared/logger.ts`：`logsDir = join(homedir(), '.nexus', 'logs')`，`mkdirSync(recursive)`，按日期/级别追加写；提供 `debug/info/warn/error` 分级，`NEXUS_DEBUG=1` 控制 debug 级。
2. 4 处调用点（`logf`、`DIAG`、`writeDiag`、`tracePerm`）全部改走该模块。

**验收 / Acceptance** ✅ 已达成
- `npm run typecheck && npm run test:smoke` 通过。
- 仓库内 `rg "C:/Users" src/ dist/` 无命中。
- 日志目录与 `~/.nexus` 数据目录一致，跨平台可写。

### A2. 附件功能不完整 / Incomplete Attachment Support · [P0] 🟢

**问题 / Problem**
- `nexus:openFile` 声明 `multiSelections` 却只返回第一个路径，多选失效。
- `file_ready` 点击是空操作，无打开/定位文件能力。
- 附件仅文件对话框，无拖拽/粘贴、无图片预览。

**方案 / Solution** ✅
1. `nexus:openFile` 返回 `{ canceled, paths: string[] }`；preload/renderer 同步数组。
2. 新增 `nexus:revealFile`（`shell.showItemInFolder`）与 `nexus:getFileInfos`（大小 + ≤2MiB 图片 dataURL 预览）IPC。
3. 附件区渲染缩略图 + 大小，点击在资源管理器中定位；`file_ready` 点击 reveal。
4. 拖拽/粘贴文件经 `webUtils.getPathForFile` 入附件（见 E3）。

**验收 / Acceptance** ✅
- 一次选择多个文件全部进入附件区；图片显示缩略图。
- `file_ready` 芯片点击可在资源管理器定位。

### A3. Worker 崩溃自动重启 / Auto-Restart on Worker Crash · [P0] 🟢

**问题 / Problem**
- `onExit` 仅发一条日志；核心崩溃后所有 IPC 永久挂起，UI 无恢复路径。

**方案 / Solution** ✅
1. `startWorker()` 改为可重建；`onExit` 触发指数退避（1s/2s/4s…上限 30s，最多 3 次）重启 worker 并重跑 `earlyInit` + `init`。
2. 新增独立 `initOkPromise` 区分 init 成功/失败/超时，避免重启判定永远等待。
3. 重启成功发 `nexus:workerRestarted`，renderer 显示提示并自动重挂最近会话。
4. `before-quit` 置 `intentionallyStopped`，防止退出时触发重启。

**验收 / Acceptance** ✅
- kill worker 进程后应用自动重启并恢复会话；重启期间请求统一 reject 不挂死。

---

## B. 性能 · Performance

### B1. 消息/会话读取 SQL 分页 / SQL Windowing for Messages & Sessions · [P1] 🟢

**问题 / Problem**
- `getMessages` 全量 `session.getMessages` 再 JS 切片；`getSessionStats` 全量拉取估算。长会话 O(n)。

**方案 / Solution** ✅
1. 原 `session-truncate.ts` 重构为 `src/session-db.ts`：新增 `getMessageWindow`/`getMessageLast`/`getMessageCount`/`estimateSessionTokens`（500 行批量估算），全部 SQL 分页。
2. `AgentService.getMessages` / `getSessionStats` 改走窗口查询；`userBefore` 用 SQL COUNT + worker-marker `substr+LIKE` 排除。
3. `regenerate/withdraw` 继续基于 `getMessageRows` + `deleteMessagesFrom`（语义不变）。

**验收 / Acceptance** ✅
- 分页响应时间与窗口大小相关而非总量；`regenerate/withdraw` 的 userIndex 语义不变。
- `npm run test:smoke` 覆盖 getMessages / getMessages last 通过。

### B2. renderer 单文件拆分 + 常量去重 / Renderer Split & Constant Dedup · [P1] 🔵

**问题 / Problem**
- `renderer.ts` 2200+ 行单文件；`WORKER_MARKERS`/`KEY_MASK`/`EARLY_METHODS` 多处重复，已现漂移。

**方案 / Solution** 🔵（阶段一已完成，阶段二延后）
- ✅ 阶段一：新建 `src/shared/constants.ts`（`EARLY_METHODS`/`WORKER_MARKERS`/`isWorkerPrompt`/`isWorkerBlockText`/`KEY_MASK`），main / worker / agent-service / renderer 统一引用（renderer 直接 ESM import `../shared/constants.js`，无需 preload 注入）。
- ✅ 阶段一：抽取 `src/renderer/i18n.ts`（STR 字典 + `t/fmtNum/applyI18n/loadLanguage`）与 `src/renderer/markdown.ts`（`renderBlocks/attachCodeCopy/hydrateImages`），成为可单测纯函数模块。
- ⏳ 阶段二（延后）：把 `sessions.ts` / `mcp.ts` / `settings.ts` 组件从 renderer.ts 完整拆出——因共享可变状态多、无 DOM 单测基础，留待 D3 测试体系落地后推进。

**验收 / Acceptance** ✅ 阶段一达成
- `npm run typecheck` 通过；`WORKER_MARKERS` 等单点定义。
- 冒烟 + 会话恢复/重生成/撤回路径手动回归正常。

---

## C. 安全 / 健壮性 · Security & Robustness

> ⚠️ 本次范围（A/B/E 组）未包含 C 组，以下仍为待办。

### C1. IPC 参数校验 / IPC Parameter Validation · [P1] 🟡

**问题 / Problem**
- `main/index.ts` `call()` 把任意 `params` 直通 worker；`chat`/`setCwd` 无类型/长度限制，`resolvePermission` 的 answer 未约束。

**方案 / Solution**
- 在 `agent-worker.ts` `handleRequest` 加校验表：每方法声明字段类型/枚举/长度上限；非法即 `respondError`。不新增依赖。

**验收 / Acceptance**
- 非法参数返回结构化错误而非透传异常；`test:smoke` 覆盖一条非法请求。

### C2. 权限弹窗支持「始终允许」/ Always Allow in Permission Modal · [P1] 🟡

**问题 / Problem**
- core `path-authorizer` 已支持 `'a'`（全局持久 allowlist），但 `askPermission` 只返回 `'y'|''`；UI 只有 Allow/Deny。

**方案 / Solution**
1. `askPermission` 支持 `'a'`；`resolvePermission` 答案白名单 `['y','a','n']`。
2. 权限弹窗加第三按钮「始终允许」→ answer `'a'`。
3. 工具调用路径对 `'a'` 判 allow（core 无工具 always 语义，先等同 once）。

**验收 / Acceptance**
- 同一路径 Always 后跨会话不再弹窗。

### C3. 主窗口 sandbox 评估 / Enable Main-Window Sandbox · [P2] 🟡

**方案 / Solution**
- 开 `sandbox: true` 并回归（preload 仅用 `contextBridge`+`ipcRenderer`+`webUtils`）；不兼容则回退并文档化。

**验收 / Acceptance**
- 全流程正常；渲染进程 `process.sandboxed === true`。

### C4. 配置 WebUI 安全复核 / Config WebUI Security Review · [P3] 🟡

**方案 / Solution**
- 复核 core `config/web.js` loopback 绑定 + token 防护；补充文档说明。

**验收 / Acceptance**
- 复核记录写入本项状态；无 loopback/鉴权缺口。

---

## D. 架构 / 工程 · Architecture & Engineering

### D1. session-db schema 耦合加固 / Schema-Coupling Hardening · [P1] 🟢

**问题 / Problem**
- 原 `session-truncate.ts` 自注 TODO「core 改列名/路径需同步」；直接复制 core `messages` 表结构。

**方案 / Solution** ✅（随 B1 一并完成）
1. 打开 DB 后 `PRAGMA table_info(messages)` 校验必需列，缺失则软失败（返回空结果 + 日志），不崩溃。
2. 收敛为 `src/session-db.ts`，对外只暴露语义化 API（`getMessageWindow/getMessageLast/getMessageRows/deleteMessagesFrom/getNonEmptySessionIds/estimateSessionTokens`）。
3. 路径派生逻辑与 core 保持一致并加锚点注释。

**验收 / Acceptance** ✅
- core 表结构变更时桌面不崩溃（降级日志可查）；`test:smoke` 通过。

### D2. `agent: any` 类型化 / Type the Agent Surface · [P2] 🟡

**方案 / Solution**
- 新建 `src/core-types.ts`：`AgentLike`/`ConfigManagerLike`/`SessionManagerLike`/`McpClientLike`/`TrackerLike`，逐方法收敛 `any`。

**验收 / Acceptance**
- `npm run typecheck` 通过；`agent-service.ts` 无裸 `any`。

### D3. 测试体系 / Test Infrastructure · [P2] 🟡

**方案 / Solution**
- 用 Node 内置 `node:test`（零新依赖）为 `markdown.ts`、`session-db.ts`（临时 DB）、`shared/constants`、i18n 键完备性加单测；`package.json` 加 `test:unit`，CI 追加步骤。

**验收 / Acceptance**
- CI 包含 `npm run test:unit`；核心纯函数覆盖率 ≥60%（目标）。

### D4. i18n 提取与 core 错误本地化 / i18n Extraction & Error Localization · [P2] 🟡

**方案 / Solution**
- STR 字典已随 B2 拆到 `i18n.ts`（✅）；`check:i18n` 脚本断言每 key 双语齐全（CI 执行）；core 常见错误前缀做轻量中英映射（⏳）。

**验收 / Acceptance**
- 新增文案漏配任一语言时 CI 报错；常见错误显示本地化提示。

---

## E. 体验 · UX (可分期)

### E1. 窗口/项目目录/草稿持久化 / Persistence: Window, CWD, Draft · [P2] 🟢

**方案 / Solution** ✅
1. 窗口 bounds：`main` 监听 move/resize（防抖 500ms）写入 `~/.nexus/desktop.json`，`createWindow` 恢复。
2. 上次 cwd：`setCwd` 成功后在主进程记录，启动时 `earlyInit` 自动应用（目录不存在则忽略）。
3. 输入草稿：`localStorage('nexus.draft.<sessionId>')` 防抖保存，切会话/重启恢复，发送后清除。

**验收 / Acceptance** ✅
- 重启后窗口位置、项目目录、当前会话草稿均恢复。

### E2. Markdown 渲染增强 / Markdown Rendering Upgrade · [P2] 🟢

**方案 / Solution** ✅
1. 抽取独立 `markdown.ts`：表格、任务列表（`- [ ]`）、代码块语言角标 + 复制按钮、图片（data:/blob:/本地路径 dataURL 水合）。
2. 流式期间 300ms 防抖增量渲染（≤12K 字符内），`turn_end` 最终渲染。
3. `renderAssistantStream` 统一在渲染后挂复制按钮 + 水合图片。

**验收 / Acceptance** ✅
- 表格/任务列表/图片/代码复制可用；流式预览无卡顿（长输出回退纯文本流式）。

### E3. 会话搜索 / 置顶 / 托盘 / 拖拽粘贴 / Search, Pin, Tray, Drag & Paste · [P3] 🟢

**方案 / Solution** ✅
1. 搜索：侧栏输入框 → `listSessions({ search })`（名称/ID 包含匹配，防抖 250ms）。
2. 置顶：`~/.nexus/desktop.json` 存 `pinnedIds`，侧栏置顶分组 + 每行 📌 按钮。
3. 托盘：`Tray`（内嵌 16×16 图标，无文件依赖）+ 菜单（打开/退出），设置中「关闭时最小化到托盘」开关（默认关）。
4. 拖拽/粘贴：composer `drop` + textarea `paste` → `webUtils.getPathForFile` 入附件，与 A2 缩略图联动。

**验收 / Acceptance** ✅
- 搜索命中、置顶生效、托盘可用、拖拽/粘贴图片可附加。

### E4. 日志查看面板 / In-App Log Viewer · [P3] 🟢

**方案 / Solution** ✅
- 设置弹窗「日志」区：读取 `~/.nexus/logs/` 最近 300 行（`recentLogLines`）渲染 `<pre>`，可刷新。

**验收 / Acceptance** ✅
- 无需外部工具即可查看/导出最近日志用于排障。

---

## 实施顺序 / Implementation Order

| 阶段 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| ① 发布质量 | A1 · A2 · A3 | - | ✅ 已完成 |
| ② 性能+工程 | B1 + D1（session-db）· B2 | D1 | ✅ 已完成（B2 阶段一） |
| ③ 安全 | C1 · C2 · C3 | - | ⏳ 待做 |
| ④ 测试 | D3（随 B2/D1 纯函数落地） | ② | ⏳ 待做 |
| ⑤ 体验 | E1 → E2 → E3 → E4 | ② | ✅ 已完成 |

> 本次迭代范围：**A、B、E 组全部完成，D1 随 B1 顺带完成**；C 组与 D2/D3/D4 及 B2 阶段二（组件拆分）留待后续。
> 每项完成后更新对应「状态」标记；`docs/development-requirements.md` 为单一事实来源。
