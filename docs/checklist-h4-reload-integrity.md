# H-4 实现 Checklist — 配置热更新完整性

> 目标：确认 ConfigManager 的所有 getter 都是活引用（live reference），
> reload() / reloadMailAndBg() 后无子系统持有过期缓存。
> 分工：**coder 侧** 审计 + 契约测试。

## 审计结果

### ConfigManager getter 审计（`src/config/index.ts`）

所有 getter 均为活引用（call-time 读 `this.config`），无构造时缓存：

| Getter | 实现 | 热更新行为 |
|---|---|---|
| `getPlatforms()` | `return this.config.platforms \|\| {}` | ✅ reload 后返回新引用 |
| `getMail()` | `return this.config.mail` | ✅ reload / reloadMailAndBg 后返回新引用 |
| `getBgConfig()` | 读 `this.config.bg` + 默认值合并 | ✅ reload / reloadMailAndBg 后返回新值 |
| `getSubAgentMaxTurns()` | 读 `this.config.subAgents` | ✅ reload 后返回新值 |
| `getContextWindow()` | 读 `this.config.contextWindow` | ✅ reload 后返回新值 |

### 调用方审计

- `getPlatforms()` 在 `config/channels.ts`、`acp/bridge/start.ts`、`acp/bridge/server.ts`、`config/web.ts`、`acp/service.ts` 中均为 **call-time 调用**，无构造时缓存。
- `getMail()` 在 `cli/config.ts`、`config/web.ts`、`security/mail-egress.ts` 中均为 call-time 调用。
- `reload()` 整体替换 `this.config = this.load()`，`reloadMailAndBg()` 窄域替换 `this.config.mail` / `this.config.bg`。

### 结论

**无需代码改动。** 唯一交付物是契约测试，锁定"getter 返回活引用"不变量。

## 改动清单

### coder 侧（`nexus-coder`）

- [x] 审计完成，无需代码改动

### 测试

- [x] `test/reload-integrity.test.mjs`（新建，5 用例）：
  - [x] `reload()` 替换 `getPlatforms()` 磁盘值
  - [x] `reload()` 替换 `getMail()` 磁盘值
  - [x] `reloadMailAndBg()` 刷新 mail + bg，**不**刷新 platforms（窄域设计）
  - [x] `getBgConfig()` 返回活值
  - [x] `getSubAgentMaxTurns()` 返回活值

### 回归

- [x] `nexus-desktop` npm run test:unit 全量通过
