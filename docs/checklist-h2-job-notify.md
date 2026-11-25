# H-2 实现 Checklist — bg_job 外部通知

> 目标：bg_job 终态（succeeded / failed / stalled）时，通过 feishu / telegram / SMTP mail
> 推送给用户，不依赖 Electron 窗口是否打开。
> 分工：**coder 侧** 改 `JobWatcher` 加 `onJobNotification` 钩子 + 导出通知管道；
> **desktop 侧** 接入钩子 + 渲染通知结果。

## 改动清单

### coder 侧（`nexus-coder`）

- [x] `src/jobs/job-watcher.ts`：
  - [x] 新增 `JobNotificationResult` 接口（jobId / kind / summary / externalDelivered / route / detail / reason）
  - [x] `JobWatcherHooks` 增加 `onJobNotification?: (job, kind, summaryText) => JobNotificationResult`
  - [x] 构造函数接受 `onJobNotification` 并存储
  - [x] `handleEvent` 的 `completed` 分支：在 `maybeWakeTurn` 后调 `fireJobNotification`
  - [x] `handleEvent` 的 `stalled` 分支：同样调 `fireJobNotification`
  - [x] `progress` 分支**不**触发（回归确认）
  - [x] `fireJobNotification` 私有方法：fire-and-forget，catch 防 crash
- [x] `src/desktop-api.ts`：
  - [x] 导出 `JobNotificationResult` 类型
  - [x] 导出 `dispatchJobNotification` + `snapshotFromConfig` 值（供 desktop 调用）

### desktop 侧（`nexus-desktop`）

- [x] `src/agent/service.ts`：
  - [x] 导入 `dispatchJobNotification` / `snapshotFromConfig` / `JobNotificationResult`
  - [x] `attachJobWatcher` 传 `onJobNotification` 钩子
  - [x] 新增 `handleJobNotification(job, kind, summaryText)` 私有方法：
    - [x] 调 `reloadMailAndBg`（窄域重载）
    - [x] 调 `dispatchJobNotification`
    - [x] 成功 → emit `job_notification` 事件
    - [x] 失败 → emit `job_notification_unavailable` 事件（含 reason + 修复提示）
- [x] `src/renderer/renderer.ts`：
  - [x] AgentEvent 联合类型增加 `job_notification` + `job_notification_unavailable`
  - [x] 渲染 case：`job_notification` → "✅ 已推送至 feishu:oc_xxx"
  - [x] 渲染 case：`job_notification_unavailable` → "⚠️ 渠道不可用：reason"
- [x] `test/fixtures/desktop-api-snapshot.json`：增加 `dispatchJobNotification` + `snapshotFromConfig`

### 测试

- [x] `test/job-notify.test.mjs`（新建，5 用例）：
  - [x] completed/succeeded 触发
  - [x] completed/failed 触发
  - [x] stalled 触发
  - [x] progress 不触发
  - [x] 无钩子时不 crash（pre-H-2 行为）

### 回归

- [x] `test/job-wake.test.mjs`（5 场景）通过
- [x] `test/contract.test.mjs` 通过
- [x] `nexus-coder` jobs tests（154 tests）通过
- [x] `npm run test:unit` 全量通过（1078 tests, 1069 pass, 0 fail）
