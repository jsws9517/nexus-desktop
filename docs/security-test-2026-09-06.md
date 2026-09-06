# Nexus Desktop — 安全测试报告 (2026-09-06)

范围：针对最近的安全加固提交（`42f14f9` 内置工具加固、`19cfffc` 进程内 sqlite/sequential-thinking、`fcd955b` 进程内 fs、`2ab66a3` audit askUser 接线、`4550695` 进程内 memory-kg）执行一次完整安全回归测试，确认**无线性回归**、无**遗漏高危**问题（已记录的设计妥协除外）。

## 结论摘要

- **回归**：无（正式 gates 全部通过）。唯一失败的 `scripts/test-worker-gate.mjs` 被判定为**陈旧的孤儿脚本**（早于 `earlyInit`/`init` 两阶段拆分，从不发 `earlyInit`，且不在 `package.json` 或 CI 中），不是代码回归。真实启动路径（`main/index.ts` 总是先发 `earlyInit`）由通过的 smoke test 覆盖。
- **修复的高危问题**：2 个。
  1. IPC 校验表缺失 `getActiveDepth` / `getActiveMode` → `/depth`、`/bypass` 查询命令在 worker 处被误拒（`unknown method`）。
  2. 主窗口 + 配置窗口缺少 `will-navigate` / `setWindowOpenHandler` 防护（窗口导航/弹窗可继承特权 preload 桥）。
- **设计妥协（接受，非遗漏）**：更新包未代码签名、sqlite `where`/`execute` 原始 DML 需批准、`unattended`/`auto` 透传调用等。

## 1. 回归基线门 (Phase 0)

| Gate | 结果 |
|------|------|
| `npm run typecheck` | PASS |
| `npm run check:i18n` | PASS (176 keys) |
| `npm run test:unit`（加入新测试后） | PASS **58/58**（原 36 + 安全 22） |
| `npm run test:smoke`（sqlite/fs/seq-thinking 覆盖） | PASS ALL |
| `node scripts/test-regenerate-guards.mjs` | PASS ALL |
| `node scripts/test-regenerate-sql.mjs` | PASS ALL |
| `node scripts/test-worker-gate.mjs` | FAIL ×2 → **判定为陈旧孤儿脚本**（见下） |

### test-worker-gate.mjs 判定

- 不在 `package.json` scripts 中，也不在任何 `.github/workflows/*.yml` 中 → **孤儿脚本**。
- 其失败方式是不发 `earlyInit` 就直接连续 `init`/`listSessions`/`startSession`，与真实启动顺序相反（真实路径 `main/index.ts` 先发 `earlyInit`）。
- 直接 worker 探针确认 `earlyInit` 返回 `ok:true`，且修复后 `getActiveDepth`/`getActiveMode` 返回 `ok:true`。
- 结论：**测试脚手架陈旧，非回归**。建议要么按当前两阶段协议重写，要么删除。

## 2. 新增永久对抗性测试 (Phase 1)

`test/security-tools.test.mjs`（22 个用例，已并入 `npm run test:unit`）：

- **sqlite-tools**：标识符注入 `t1"; DROP TABLE x; --` 被引号隔离、`__proto__`/`constructor` 原型污染键被控、堆叠语句（`; DROP`）被拒、危险 `PRAGMA`/`ATTACH`/`DETACH` 被拒、只读 `query`(`fileMustExist`) 不新建库文件、`create-table` 非法 DEFAULT 字面量被拒、写工具拒绝批准门、越权自定义 `dbPath` 被拒。
- **fs-internal**：`read_media_file` 魔数嗅探（假 `.png` 被拒 / 真 PNG 通过）、8 MiB 大小上限、越权目录（授权边界外）被拒、`list_directory_with_sizes` 的 `maxDepth` 钳制。
- **sequential-think**：`branchId: '__proto__'` 走 Map 不触原型链、超大 thought 被拒、非法参数（`thoughtNumber=0`）被拒。
- **memory-kg**：损坏 JSONL 优雅降级为可读错误而非崩溃、`MEMORY_WRITE_TOOLS` 对所有非读工具（create/add/delete/update）标记正确的批准门契约。
- **ipc-validation**：`agent-worker.ts` 中每个分发的 worker 方法都有 IPC 校验 spec（**此用例捕获了第 1 号高危**）、对抗性参数（超长 `input`、非字符串、非法 answer、未知方法）被拒。
- **工具集完整性**：sqlite 10 个、fs 3 个内置工具集合与设计一致。

### 高危 #1 — IPC 校验表缺失两个查询方法（已修复）

- 现象：`validateWorkerParams` 将 `getActiveDepth` / `getActiveMode` 判为 `unknown method`，在 `agent-worker.ts` 校验门处被拒。
- 影响：渲染层 `nexus:getActiveDepth`/`getActiveMode` IPC 暴露了这两个方法（`preload.cts` + `renderer.ts` 声明），对应 `/depth`、`/bypass` 查询命令 → 功能回归。
- 修复：`src/shared/ipc-validation.ts` 增加 `getActiveDepth: { fields: {} }` 与 `getActiveMode: { fields: {} }`。
- 验证：直接 worker 探针现返回 `getActiveDepth => ok:true data:"off"`、`getActiveMode => ok:true data:"unattended"`；新增 triage 用例通过。

## 3. Electron 导航防护 (Phase 2)

### 高危 #2 — 主/配置窗口缺少导航防护（已修复）

- 现象：`createWindow`（`src/main/index.ts:368`）与 `openConfigWindow` 均无 `will-navigate` 处理器、无 `setWindowOpenHandler`。
- 威胁：若渲染层存在可被诱导的导航（页面内链接、`window.location`、`target=_blank`），指向攻击者 URL 的导航/新窗口会**继承同一特权 preload 桥**（`sandbox:true` + `contextIsolation:true` 限制仍在，但 `nexus:*` 特权 IPC 与后续 `webContents.send` 敏感事件仍可达）。渲染层虽无 `window.open`/`openExternal` 调用（已 grep 确认），防护仍属纵深防御必须项。
- 修复（`src/main/index.ts`）：
  - 主窗口：`will-navigate` 仅允许停留在当前 `index.html` 的 file URL，其余 `preventDefault()`；`setWindowOpenHandler(() => ({ action: 'deny' }))`。
  - 配置窗口：`will-navigate` 仅允许 `http://localhost:<本进程绑定的 port>` 前缀，其余 `preventDefault()`；`setWindowOpenHandler` deny。
- 验证：`scripts/electron-nav-check.cjs`（隐藏窗口、复用 `sandbox:true` + `contextIsolation:true` + preload 配置）动态证明 `window.open()` 被拒、`location.href` 指向他文件被 `will-navigate` 阻止、窗口停留原 URL。该脚本保留为永久工件（可重复运行，无副作用）。

## 4. 供应链 (Phase 4)

- `npm audit`（prod + dev）：**0 vulnerabilities**。
- 更新器（`src/main/updater.ts`）：HTTPS feed + `electron-updater` 默认对 `latest.yml` 中的 **sha512 校验**（完整性有保障，镜像不可篡改二进制）。升级为手动三步（autoDownload/autoInstallOnAppQuit 均关）。
- **设计妥协（已接受）**：Windows 目标未**代码签名**（electron-builder 无 `publisherName`/`certificateFile`）。sha512 保障完整性，但无 Authenticode 证书 → 无法验证发布者身份。缓解：需购买代码签名证书并设置 `publisherName`，本轮不改。

## 5. 已确认关键安全特性（复核）

- **C3 沙箱**：主/配置窗口均 `sandbox:true` + `contextIsolation:true` + `nodeIntegration:false` + CJS preload（`docs` 中"C3 未启用"的描述**已过时**）。
- **C4 core 网络**：`config/web.js` 按进程随机 Bearer token + loopback 仅 `127.0.0.1` + Host 头校验（文档"C4 待办"**已过时**）。
- **日志**：经 `src/shared/logger.ts` 写入 `~/.nexus/logs`（文档"C3 完成"已实现）。
- **sqlite**：全程参数化；`src/session-db.ts` LIKE 通配符转义（typo 已在此前会话）——本报告新增测试覆盖 `getSessionIdsByTaskGraph` 通配符转义（如既有）。
- **渲染**：`renderer/markdown.ts` 先转义后渲染；CSP `script-src 'self'` 无 `unsafe-eval`。

## 交付物清单

| 文件 | 类型 |
|------|------|
| `test/security-tools.test.mjs` | 永久对抗性测试（并入 `npm run test:unit`） |
| `scripts/electron-nav-check.cjs` | 永久 Electron 导航防护动态检查 |
| `src/shared/ipc-validation.ts` | 修复：补 `getActiveDepth`/`getActiveMode` |
| `src/main/index.ts` | 修复：主/配置窗口导航防护 |
| `docs/security-test-2026-09-06.md` | 本报告 |

## 建议后续（未阻塞本轮）

1. 用当前两阶段协议重写或删除 `scripts/test-worker-gate.mjs`（避免误导）。
2. 采购代码签名证书并设置 `publisherName`，关闭更新签名妥协。
3. 更新 `docs/development-requirements.md` 中关于 C3/C4 的过期描述（现均已实现/启用）。
