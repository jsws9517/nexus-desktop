# H-3 实现 Checklist — tmp_cleanup 工具

> 目标：模型可一键清理 `.nexus/trash/`（项目级 scratch 约定目录）+ 全局 `~/.nexus/trash/`，
> 不再依赖"会话结束手动删"。unattended 模式下 trash 清理自动放行（非破坏性）。
> 分工：**coder 侧** 工具 + 权限；**desktop 侧** 路由关键词。

## 改动清单

### coder 侧（`nexus-coder`）

- [ ] `src/mcp/builtin-tools.ts`：
  - [ ] 新增 `tmp_cleanup` 工具定义
  - [ ] 参数：`target`（enum: trash / scratch / all）、`olderThanHours`（默认 24）、`dryRun`（默认 false）
  - [ ] 实现：
    - [ ] `trash` → 清理 `~/.nexus/trash/`（调现有 `cleanTrash` 逻辑 + 项目 `.nexus/trash/`）
    - [ ] `scratch` → 清理会话 scratch 目录（`process.cwd()/.nexus/trash/`）
    - [ ] `all` → 两者
    - [ ] `dryRun=true` → 列出将被删除的文件 + 总大小，不实际删除
    - [ ] 只删 `olderThanHours` 以内的文件（0 = 全删）
  - [ ] 返回 `{ removed: N, freedBytes: X, files: [...] }` 或 dryRun 的 `{ wouldRemove: N, wouldFreeBytes: X }`

- [ ] `src/hooks/permissions.ts`：
  - [ ] `tmp_cleanup` 加入 `DRY_RUN_FILE_TOOLS`（dry_run 预放行）
  - [ ] `tmp_cleanup` 加入 `DEFAULT_PERMISSIONS` 为 `Allow`（非破坏性清理）
  - [ ] unattended 模式下 `target: 'trash'` + `olderThanHours >= 1` 自动放行
  - [ ] unattended 模式下 `target: 'all'` 或 `olderThanHours: 0` 需确认（Prompt）

- [ ] `src/contract.ts`：
  - [ ] `CORE_TOOL_NAMES` 加 `tmp_cleanup`

### desktop 侧（`nexus-desktop`）

- [ ] `src/tools/routing.ts`：
  - [ ] `tmp_cleanup` 路由关键词（'清理' / 'cleanup' / '临时文件' / 'trash' / 'clean up temp'）
- [ ] `test/contract.test.mjs`：契约更新（自动，无需手改）

### 测试

- [ ] `nexus-coder/tests/mcp/tmp-cleanup.test.ts`（新建，6 用例）：
  - [ ] trash 目标删除 > 24h 的文件
  - [ ] dry_run=true 不实际删除
  - [ ] olderThanHours=0 全删
  - [ ] 空 trash 目录返回 removed: 0
  - [ ] 项目 `.nexus/trash/` 也被清理（scratch 目标）
  - [ ] 不碰 tracked 文件（只碰 `.nexus/trash/`）

### 回归

- [ ] `nexus-coder` mcp tests 全量通过
- [ ] `nexus-desktop` contract.test.mjs 通过
- [ ] `nexus-desktop` npm run test:unit 全量通过
