# H-3 实现 Checklist — tmp_cleanup 工具

> 目标：模型可一键清理 `.nexus/trash/`（项目级 scratch 约定目录）+ 全局 `~/.nexus/trash/`，
> 不再依赖"会话结束手动删"。unattended 模式下 trash 清理自动放行（非破坏性）。
> 分工：**coder 侧** 工具 + 权限；**desktop 侧** 路由关键词。

## 改动清单

### coder 侧（`nexus-coder`）

- [x] `src/mcp/builtin-tools.ts`：
  - [x] 新增 `tmp_cleanup` 工具定义（`target` / `olderThanHours` / `dryRun`）
  - [x] `trash` → 清理 `~/.nexus/trash/`；`scratch` → 清理 `<cwd>/.nexus/trash/`；`all` → 两者
  - [x] `dryRun=true` 列出将被删除的文件 + 总大小，不实际删除
  - [x] `olderThanHours=0` 全删（cutoffMs=Infinity）；默认 24
  - [x] 返回 `Cleaned up N file(s), freed ~X` 或 `[dry_run] Would remove N file(s)`
- [x] `src/hooks/permissions.ts`：
  - [x] `tmp_cleanup` 加入 `DRY_RUN_FILE_TOOLS`（dry_run 预放行）
  - [x] `tmp_cleanup` 加入 `DEFAULT_PERMISSIONS` 为 `Allow`（非破坏性清理）
  - [x] unattended 模式下 `target: 'all'` 或 `olderThanHours: 0` 被 deny（防误删）
  - [x] unattended 模式下 `target: 'trash'` + `olderThanHours >= 1` 自动放行
- [x] `src/contract.ts`：`CORE_TOOL_NAMES` 加 `tmp_cleanup`

### desktop 侧（`nexus-desktop`）

- [x] `src/tools/routing.ts`：`tmp_cleanup` 路由关键词
- [x] `test/contract.test.mjs` 契约通过

### 测试

- [x] `test/tmp-cleanup.test.mjs`（新建，6 用例）：
  - [x] trash 目标删除 > 24h 的文件
  - [x] dry_run=true 不实际删除
  - [x] olderThanHours=0 全删
  - [x] 空 trash 目录返回 0
  - [x] 项目 `.nexus/trash/` 也被清理（scratch 目标）
  - [x] 不碰 tracked 文件（只碰 `.nexus/trash/`）

### 回归

- [x] `nexus-coder` mcp tests：90 pass / 0 fail / 1 skipped ✅
- [x] `nexus-desktop` npm run test:unit：1084 tests / 1075 pass / 0 fail / 9 skipped ✅
