# Harness 加固路线（P0/P1/P2 + B/C 残留项）

本文件记录 11/16 会话失败轨迹的加固落地状态、真实对话验证证据与复测配方。
约束：不新增服务、不改 DB schema、不做虚拟化/greenfield 重构；每项都落在现有
`nexus-coder` / `nexus-desktop` 架构内，以最小改动换取可观测收益。

## 1. 状态总览

| 项 | 内容 | 代码位置 | 状态 |
| --- | --- | --- | --- |
| P0-1a | `expect` 产物门禁：退出 0 但未产出视为 `gate_result: blocked` | `nexus-coder/src/jobs/artifacts.ts`、`manager.ts` | 完成 |
| P0-1b | 门禁结果进入完成通知与 `bg_job status` 详情 | `summary.ts`、`bg.ts` | 完成 |
| P0-2 | `bg_job plan` 自然语言拆解为多作业（含 dry-run） | `jobs/bg-plan.ts`、`agent.ts` | 完成 |
| P0-3 | exec/bg 命令分级在 dry-run 下可预检 | `mcp/builtin-tools.ts`、`hooks/permissions.ts` | 完成 |
| P1-4 | 完成/失败通知携带 `gate_result` 与缺失产物 | `jobs/summary.ts` | 完成 |
| P1-5 | `bg_job status/tail` 的 idle/ETA/stalled 提示 | `jobs/bg.ts` | 完成 |
| P1-6 | 失败通知附带日志尾部与定位命令 | `jobs/summary.ts` | 完成 |
| P1-7 | 桌面选路：中文提示词不再丢掉 `spawn_subagent` 等工具 | `nexus-desktop/src/tools/tool-relevance.ts` | 完成 |
| P2-1 | `exec_command dry_run` 不被 unattended 安全门拦截，真跑仍拦截 | `hooks/permissions.ts` | 完成 |
| B-1 | 跨进程恢复 `bg_job status`（tracker DB + 最近通知） | `task/progress-tracker.ts`、`agent.ts`、`jobs/manager.ts` | 完成 |
| B-2 | 纯“读日志”提示词下读取工具排在 `bg_job` 之前 | `tools/routing.ts`、`tools/tool-relevance.ts` | 完成 |
| C-1 | GBK/UTF-16/BOM 文本读写保真；GBK 文件拒绝编辑并给出转换提示 | `utils/file-text.ts`、`mcp/builtin-tools.ts` | 完成 |
| C-2 | `delete_file`/`move_file`/`copy_file` 支持 `dry_run` 预演 | `mcp/builtin-tools.ts`、`hooks/permissions.ts` | 完成 |
| C-3 | stall 通知携带日志大小/路径/尾部，仍不自动 kill | `jobs/{types,manager,summary,job-watcher,daemon}.ts` | 完成 |

剩余仅为发布收尾（提交/打 tag/推送），无功能缺口。

## 2. B/C 细节

### B-1 门禁结果持久化（不改表）

- 写侧：`JobManager.finalize()` 在 `gateResult.status === 'blocked'` 时，把
  `summarizeJob()` 的终态文本写入现有 `job_notifications`（复用文本承载，不新增列）。
  只写 blocked，避免与 daemon 的正常终态通知重复。
- 读侧：`bg_job status` 在内存 manager 中找不到 job 时，回退
  `tracker.getJob(id)`，并附 `tracker.latestNotification(id)`（非 progress 优先、
  最新优先）。输出带 `[restored]` 前缀，并说明 `wait` 不可用（没有本进程可等的子进程）。
- 已验证：新进程查询旧作业能拿到 `status/exit_code` 与
  `gate_result: blocked`、`missing`。

### B-2 读日志选路

- `routing.ts` 为 `read_text_file` / `file_read` / `read_multiple_files` 补齐
  文件/日志关键词（含 `日志文件`、`log file`、`读取文件` 等）。
- `tool-relevance.ts` 新增 `isFileReadIntent()` 与专用权重 `W_FILE_READ = 0.25`
  （高于 `W_WIN32_OBS = 0.15`）：读内容意图让读取工具压过 `bg_job`；
  作业状态意图（`完成了吗`、`还在跑`、`kill`）仍让 `bg_job` 第一。
- 注意：桌面选路是纯函数，验证在进程内用**生产 routing + 真实工具描述**完成；
  Electron 聊天窗口自动化不在本项范围。

### C-1 文本编码保真

- `utils/file-text.ts`：BOM → UTF-16 NUL 分布 → 严格 UTF-8 → GBK → binary 的检测顺序；
  `decodeTextFile` 返回 `{ encoding, text, bom }`，`encodeTextFile` 按原编码+BOM 写回。
- `read_text_file` 两处读取均按检测编码解码（GBK 日志、PowerShell UTF-16 产物不再变
  U+FFFD）。
- `edit_file` 只对 `utf8 / utf8-bom / utf16le / utf16be` 写回；GBK/binary 直接拒绝，
  返回 `Convert it to UTF-8 ...` 的可执行提示，绝不以 UTF-8 覆盖原字节。

### C-2 文件变更预演

- 三个工具新增 `dry_run`，返回类型/大小/目标是否已存在（覆盖风险）/将执行的系统调用；
  目录删除还会报告是否为空、前 10 个条目。
- 权限层 `DRY_RUN_FILE_TOOLS` 预演直接放行（`delete_file` 默认 Deny、unattended 门都会拦），
  真实调用策略不变。

### C-3 stall 证据

- `JobManagerEvent` 的 `stalled` 变体新增 `tail?: string[]`，由 `progressTail(logFile, 6)`
  有界填充。
- `summarizeStalled(job, idleMs, tailLines?)` 输出：日志大小、日志路径、末几行
  （无输出时明确说“可能块缓冲”）、`bg_job tail=<id>` 指针。
- `job-watcher`、`daemon` 透传 `ev.tail`；状态机与自动 kill 行为未改。

## 3. 真实对话验证（2026-11-16）

隔离配置：`NEXUS_CONFIG_DIR=%TEMP%\opencode\nexus-iso`
（`permissions.mode=unattended`、`wake.stallAlertMs=1000`），
工作目录 `%TEMP%\opencode\conv-work`，模型 `agnes-2.5-flash`。
CLI：`node D:\agent-cli\nexus-coder\dist\src\cli\index.js run "<prompt>"`。

| 项 | 提示词要点 | 结果 |
| --- | --- | --- |
| C-1 读 | 读取 `gbk-note.txt` / `utf16-note.txt` / `bom-note.txt` | 三个文件内容全部可读，无替换字符 |
| C-1 编辑 | 把 GBK 文件里的 `alpha` 改成 `gamma` | 返回 `detected gbk encoding` + 转换提示；文件字节未变 |
| C-2 | `delete_file`×3（文件/空目录/非空目录）+ `move_file`，全部 `dry_run=true` | 分别输出 `unlink`、`rmdir (empty, deletable)`、`would_fail: directory is not empty`、`rename`；无任何实际变更 |
| B-1 | 进程 A：`bg_job launch expect=["missing-output.txt"]`；进程 B：`bg_job status id=...` | 进程 B 输出 `[restored]` + `gate_result: blocked` + `missing-output.txt` |
| B-2 | 进程内用生产 routing + 真实描述排序 | 读日志提示词 `read_text_file` 第 0、`bg_job` 第 1；作业状态提示词 `bg_job` 第 0 |
| C-3 | 真实子进程写两行后 sleep，`stallAlertMs=800` + 真实 `JobManager`/`JobWatcher` | 通知含 `日志 44B`、日志路径、两行尾部、`bg_job tail=<id>` 指针 |

B-1 首次真实验证发现通知并未落库（`job_notifications` 为空），`[restored]` 只有行数据。
已在 `JobManager.finalize()` 补写 blocked 门禁通知后复测通过——这正是“真实对话验证”
能抓到、单测抓不到的问题。

## 4. 复测配方

1. 复制真实 `config.json` 到隔离目录，改 `permissions.mode="unattended"`、
   `wake.stallAlertMs=1000`（stall 需要较小阈值）。
2. 全角引号/中文提示词写入 `.txt`，用 `Get-Content -Raw` 读入变量后再传给 `run`；
   直接内联会被外层 shell 扫描器误判为 `invalid-structure`。
3. B-1 必须**两个进程**：先 launch（带缺失 `expect`），再新进程 status。
4. C-3 需要调用 `manager.start()`（tick 循环）并挂 `JobWatcher`；
   CLI 单轮 `run` 在作业结束前就退出，观察不到 stall 窗口。
5. 验证完成后检查字节/文件存在性，确认 dry-run 与拒绝路径没有副作用。

## 5. 回归

- `nexus-coder`：`tests/jobs/*` + `tests/security/*` + `tests/mcp/*` → 602 tests，
  601 pass / 1 skipped / 0 fail。
- `nexus-desktop`：`npm run test:unit` → 844 tests，835 pass / 9 skipped / 0 fail。
- 新增回归：`tests/jobs/bc-hardening.test.ts`、`tests/security/file-text-encoding.test.ts`、
  `tests/security/b-tier-hardening.test.ts`（C-2 用例）、
  `nexus-desktop/test/tool-relevance.test.mjs`（B-2 两条）。
