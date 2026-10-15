# 桌面端一次性附件 RAG 开发计划（One-Time Attachment RAG）

> 状态：🟡 计划中（Pending）
> 关联仓库：`nexus-desktop`（主）+ `nexus-coder`（core）
> 依赖：core 提取器注册表（本计划 P1-P4）
> 关联文档：[module-map-panels-and-runs.md](./module-map-panels-and-runs.md)
> 创建：2026

---

## 一、功能概述

当用户在桌面端添加一个**扩展名落在可配置白名单内**的附件文件时，桌面端会：

1. **入库（Ingest）**：把文件内容分块，写入一个**随会话一次性、临时的**本地 RAG 数据库，并保存**文件级 + 分块级元数据**。
2. **发送时先检索（Hybrid 混合模式）**：
   - 附件集较小时 → 自动预检索，把命中的 Top-k 片段注入上下文后再让模型回答；
   - 附件集较大时 → 暴露 `attachments_search` 工具，由模型按需检索。
3. **生命周期**：在 `/clear`、会话关闭、会话删除时，删除该会话的 RAG 数据库。

**实现顺序**：先在 core 建立「提取器注册表」（本功能是其第一个使用者），然后实现本功能；Office/PDF 等重格式在扩展包落地后自动被拾取。

**核心约束**：RAG 附件挂钩必须**独立存在**，**不得**复用常见的 `+`（附加按钮）机制。

---

## 二、现状接线（为什么必须独立）

- 现有 `+` 流程：`#btn-attach` → `openFile()` 多选对话框 → `attachFiles(paths)` → 存入 `attachments[]` → 在 `#attachments` 渲染标签 → 发送时把每个附件拼成 `@{绝对路径}` 行加入对话输入（renderer.ts:538-539、4414-4415、2166）。
- 拖拽、粘贴图片也都走 `attachFiles()`。

RAG 路径**完全不接触** `#btn-attach`、`attachFiles()`、`attachments[]` 数组以及 `@path` 拼接逻辑。

**发送时因此更简单**：入库发生在 worker 的「每会话 RAG 库」中，而 worker 知道当前 `sessionId`。所以无需解析 `@token`、无需给 `chat` 增加参数。每次 `chat()` 时 worker 直接检索**自己**当前会话的库（混合模式），渲染端在发送时无需传 RAG 路径。

---

## 三、Core 端改动（`nexus-coder`）

### P1. 提取器注册表（零新增运行时依赖）
- 新增 `src/vault/extract/registry.ts`：
  - `registerExtractor(ext, fn)`、`getExtractors()`、`extractForRag(path, ext)` → `{ text, format } | null`。
- 内置提取器（全部零依赖）：`md`（去 frontmatter）、`txt/log/code`、`csv`、`json`、`html`（复用 `src/web/fetch.ts` 的 `htmlToMarkdown`）。
- 分块工具：优先复用 `vault/store.ts` / `indexer.ts` 中已有的 CJK 感知分词逻辑；若无可用的则新增最小化的 `chunkText()`。
- 在 `tests/vault/` 添加测试。

### P2. 扩展名白名单配置（共用 config-web 界面）
- `src/config/types.ts` 的 `KnowledgeConfigSchema`（约 458 行）新增：
  - `attachmentExtensions: z.array(z.string())`；
  - 默认值 `['md','txt','pdf','docx','xlsx','pptx','csv','json','html','log']`；
  - 图片默认**不**加入（vision 路径已覆盖图片），白名单可由用户自行编辑。
- `src/config/web.ts`（约 2634 行）Knowledge 面板新增扩展名列表编辑器；在 `web-i18n.ts` 补充 i18n 文案。

### P3. Vault 存储新增（累加式，不破坏既有库）
- `src/vault/store.ts`：
  - 新增 `CREATE TABLE IF NOT EXISTS vault_meta`（ref 主键、path、name、size、ext、mtime_ms、ingested_at、chunk_count、status）；
  - 新增 `upsertMeta()` / `getMeta()` / `listMeta()`；
  - 新增 `deleteAll()`（用于会话库重置）；
  - 构造函数已支持 `dbPath` 参数（store.ts:83）→ 每会话一个库文件，**现有 `vault.db` 无需迁移**。

### P4. 注入内容不入库
- `src/agent.ts:260` 的 `stripAtExpansionSuffix` 正则追加 `Attachment context` 标记，确保注入的上下文块不会写入会话数据库（与 CLI 的 `[Referenced file:]` 拼接处理一致）。

---

## 四、桌面端改动（`nexus-desktop`）

### P5. 会话 RAG 模块 —— 新增 `src/agent/attachment-rag.ts`
- `storeFor(sessionId)`：用 core `VaultStore` 打开 `~/.nexus/session-rag/<sessionId>.db`（沿用 `agent/service.ts` 现有深 import 模式）。
- `ingestAttachments(sessionId, paths, allowlist)`：
  - 读取文件 stat → 按扩展名从注册表取提取器 → 提取 → 分块 → `upsertNote`（ref 格式 `attach:<sha1(path)>:<i>`）+ `upsertMeta`（文件级行）；
  - 返回每个文件的 `{ path, ok, reason, chunkCount }`。
- `search(sessionId, query, k)`：返回 Top-k 命中；`buildContextBlock(hits)` → `\n\n[Attachment context: <文件> — <片段>]`。
- `removeAttachment(sessionId, path)`：按 ref 删除该文件的 note + meta。
- `reset(sessionId)` / `dispose(sessionId)`：删除 `.db` 及 `-wal` / `-shm` 文件；损坏则重建（模仿 `desktop-state.ts:154` 的隔离策略）。

### P6. Worker 接线
- `src/agent/service.ts`：
  - `ingestAttachments(sessionId, paths)`、`removeAttachment(sessionId, path)`、`clearAttachmentStore(sessionId)` —— 与 `chat()` 的消息状态完全解耦。
  - `chat()` 钩子（约 1319 行）：若当前会话库非空 → 混合检索（仅在总块数 / Token 预算内才自动注入，否则走 `attachments_search` 工具）。
  - `/clear`（约 1410 行）→ `clearAttachmentStore`；`deleteSession`（约 2524 行）→ 释放库；会话关闭时尽力清理 + 启动时清扫孤儿 `session-rag/*.db`。

### P7. `attachments_search` 桌面工具
- 在 `src/tools/index.ts` 注册（按会话作用域），遵循白名单 + 安全路径门控；
- 在 service 中特判，使其查询会话 RAG 库；尊重 `src/tools/types.ts` 的计划模式 / 角色白名单收窄。

### P8. 渲染端 —— 独立 RAG 入口（关键改动）
- 新增**独立的「RAG 附件」按钮**，置于 `+` 组合控件旁（不同图标/文案），并拥有**独立的标签区** `#rag-attachments`（新增）与独立状态数组 `ragAttachments`。
- **`renderAttachments()`、`#attachments`、`attachmentsEl`、`attachFiles()` 一律不动**，公共 `+` 流程保持原样。
- 点击 → 复用 `openFile()` 多选对话框（register.ts:496）→ 调用 `nexusDesktop.ragIngest({ sessionId, paths })`。
- RAG 标签显示入库结果：`RAG · n块`（成功）/ `需要扩展`（缺扩展包）/ `错误`（异常）；不在白名单内的文件显示「不在 RAG 白名单」——但**不会**转入 `@path` 流程。
- 每个标签可单独移除 → `ragRemove` IPC；提供「清空 RAG」操作 → `ragClear`。
- 发送时 `sendMessage()` / `drain()` **不**把 RAG 文件拼进输入；检索由 worker 内部完成。RAG 标签区在整个会话期间持续可见（与发送后即清空的公共附件不同）。
- 在 `src/renderer/i18n.ts` 补充 i18n 文案，运行 `npm run check:i18n` 校验。

### P9. Office/PDF 集成（已完成）

原计划推迟的「重型提取器扩展包」已落地，不再是桌面端代码的假设：

- **core**：新增 `src/vault/extract/formats.ts` 声明式格式清单（`{ext, kind: builtin|package, package?}`），
  取代原先散落在 `DEFAULT_ATTACHMENT_EXTENSIONS` 与配置页里的两份硬编码列表；
  `registry.ts` 的 `Extractor` 契约扩展为支持 async（`extractForRag` 返回 Promise），
  因为 PDF/Office 只有异步解析器可用。
- **core**：新增 CATALOG 条目 `doc-extract`（`type: 'extractor'`），安装到
  `~/.nexus/native/extractors/doc-extract/`，入口 `index.mjs` 由
  `src/config/assets/doc-extract.mjs` 生成。只依赖 `jszip` + `pdf-parse`：
  docx/xlsx/pptx 直接读 OOXML zip 容器，一个读取器覆盖三种格式。
- **desktop**：`src/agent/extractor-loader.ts` 在 worker `earlyInit` 阶段加载这些包。
  必须由 worker 加载而非主进程 —— 配置页装在主进程，而唯一会读附件做 RAG 的是 worker 进程。
  坏包只记日志并跳过，绝不阻断启动。
- **portable**：包与它自己的 `node_modules` 都在 `~/.nexus` 下，整个目录搬到另一台机器即可用；
  `config.json` 只存扩展名白名单，能力由 `formats.ts` 的 `package` 字段指向可安装包。
- 扫描版 PDF 的 OCR 仍暂缓（`doc-extract` 只读 PDF 文本层）。

---

## 五、IPC 新增（新增通道，`chat` 签名不改）

- `src/ipc/channels.ts` + `src/ipc/register.ts` + `src/preload.cts`：
  - `ragIngest { sessionId, paths }`
  - `ragRemove { sessionId, path }`
  - `ragClear { sessionId }`
- `src/shared/ipc-validation.ts` WORKER_METHODS：仅新增上述三个方法，`chat` 不变。

---

## 六、假设与边界情况

- 入库为异步、不阻塞（发送时检索「当时已入库」的内容）。
- 同一文件重复添加 → 以 `sha1(path)` 为 ref 幂等 upsert。
- 文件被移动/删除 → 优雅报 `reason`，回退到 `@path` 内联读取。
- 伪装成 txt 的非 UTF-8 / 二进制 → 检测后跳过（参考 `filesystem.ts:61` 的 magic-byte 思路）。
- CJK 内容：`splitCjkForFts` 已处理，无需额外工作。
- 图片 OCR 入库、会话 RAG 可见性面板：暂缓，不做进本功能。

---

## 七、验证

- Core：`npm run typecheck` + `npm test`。
- Desktop：`npm run typecheck`（自动先跑 `sync:core`）+ `npm run check:i18n` + `npm run test:unit` + 手工冒烟：
  - 独立入口添加文件 → 标签显示状态 → 提问 → 上下文已注入 → `/clear` → 库被删除。

---

## 八、涉及文件清单

**core（`nexus-coder`）**
- `src/vault/extract/registry.ts`（新增）
- `src/vault/store.ts`（`vault_meta` 表 + 方法 + `deleteAll`）
- `src/config/types.ts`（`attachmentExtensions`）
- `src/config/web.ts` + `src/config/web-i18n.ts`（配置项 UI）
- `src/agent.ts`（strip 正则追加 `Attachment context`）
- `tests/vault/*`（新增测试）

**desktop（`nexus-desktop`）**
- `src/agent/attachment-rag.ts`（新增）
- `src/agent/service.ts`（入库/移除/清空 + `chat` 钩子 + 生命周期）
- `src/agent-worker.ts`、`src/shared/ipc-validation.ts`、`src/ipc/channels.ts`、`src/ipc/register.ts`、`src/preload.cts`（IPC）
- `src/tools/index.ts`、`src/tools/*`（`attachments_search`）
- `src/renderer/renderer.ts`（独立 RAG 入口 + 标签区）
- `src/renderer/i18n.ts`（文案）
