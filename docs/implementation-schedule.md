# Nexus Desktop 后续实现排期

> 归档日期：explicitly the current session reading (read-only 核验，未改代码)
> 依据：§8 roadmap + §11 测试矩阵 vs 真实代码/测试核对
> 状态图例：✅ 已闭环　⬜ 未落地（本项目排期）　✔ 建议并入同一 commit

## 1. 状态总览（核验依据见脚注）

| 阶段编号 | P0 快赢 / P1 UX / P2 / P3 | 交付物 | 状态 |
|---|---|---|---|
| §3 / P0 | 宪法注入 + 32KB 上限/回退链 | ✅ |
| §3.6 / P0 | agents_index / read / search + `[adjusted]` | ✅ |
| §5.3 / P0 | 模型能力声明 + vision 路由提示 | ✅ |
| §3.7 / P0 | 宪法在子代理中的显式继承 | ✅ |
| §8 / P2 | 多代理并行执行器 + 任务卡驻 sidebar | ✅ |
| §8 / **P0** | **上下文进度条 + TPS 表头** | ⬜ **G1（下一迭代优先）** |
| §8 / **P1** | **用量统计面板** | ⬜ **U1** |
| §8 / P3 | 任务看板 + cron | ⬜ O1 |
| §8 / P3 | Session 归档 | ⬜ O2 |
| §6.4 / P3 | double-Esc 快退 / 流式重放 | ⬜ O3（低优先级 concept） |

脚注（核验证据，文件:行）：
- G1 未做：`getStatus` 的 IPC 载荷在 `src/shared/ipc-validation.ts:64` 为 `fields:{}`（空），
  渲染端 StatusInfo 只有 cwd/busy/provider/model，**无 contextLimitUsed/TPS**；
  渲染端仅文字 token 读数（无 gauge 元素）；`test/gauges.test.mjs`（§11.1）缺失。
- U1 未做：`parallel_end` 的 tokenUsage 仅 console 记录，无聚合面板；
  `test/model-capabilities.test.mjs`（§11.1）缺失。
- G1 的前置（能力声明 → contextLimit 已知）已闭环，**零阻塞**；U1 的前置（用量归属 capability）同源。

## 2. 依赖解耦

- G1（进度条+TPS）：能力/latency 数据已就绪 → **零阻塞**，纯渲染端 UI，无新增 I/O，天然无人值守安全。
- U1（用量面板）：前置=能力声明（成本归属）→ **已解锁**。
- O1（任务看板）：依赖 P2 任务实体 → **已解锁**。
- 三者均不触碰宪法/WORK_MARKER/vision 三个 marker 路径 → 满足 §8.1 隔离规则，每项可独立 strip。

## 3. 排期表（按未阻塞程度从高到低；采用 §8.1 的 P0 优先原则，非旧 §6 顺序）

### Sprint A —— P0（约 2.5–3 天）
- **G1** 上下文进度条 + TPS 表头
  - 扩展 `getStatus` 载荷：`contextLimitUsed`（滚动窗口）、滚动 TPS、`contextLimit`（能力声明值）
  - 渲染端：sidebar/session 面板加 gauge 条 + TPS 读数（替换/增强现有文字 token 读数）
  - 新增 `test/gauges.test.mjs`（§11.1，node --test 无框架）
- **G2**（✔ 同 commit）补能力声明单测 `test/model-capabilities.test.mjs`
- 验收：依赖注入单测通过；渲染端出现 gauge；无新增 IPC 通道

### Sprint B —— P1（约 2–3 天）
- **U1** 用量统计面板
  - 聚合各 session/model 的 prompt/completion token
  - 可选：按 capability 折算 $/1M 成本
  - 新增 `test/usage-panel.test.mjs`
- 依赖：G1 已交付的能力载荷

### Sprint C —— P3（约 3–4 天）
- **O1** 任务看板 + cron 触发（依赖 P2 任务实体 → 已解锁）

### Sprint D —— P3（约 2–3 天）
- **O2** Session 归档　+　**O3** double-Esc 快退 / 流式重放（低优先）

## 4. 工程约定（沿用项目宪法 §1/§3）
- 每 feature 至少一个单测（`node --test`，`test/*.test.mjs`，无框架），与功能同 commit。
- 纯渲染端 UI 改进天然满足主力民族「无人值守安全」：无新许可门、无交互弹窗。
- 不进 marker 路径（宪法/WORK_MARKER/vision），保证每个提交可独立回退。

## 5. 建议落地顺序（供下个会话直接续接）
```
Sprint A（P0）→ G1 + G2  ← 一次 commit，先做
Sprint B（P1）→ U1
Sprint C（P3）→ O1（任务看板 + cron）
Sprint D（P3）→ O2 + O3
```
知识图谱已记录此结论（nexus-desktop 排期核验结论，2026-09 只读核验）。
