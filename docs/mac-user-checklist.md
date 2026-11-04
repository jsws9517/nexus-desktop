# macOS arm64 beta — 真机验证清单

**包**: `nexus-0.3.3-arm64.dmg`（120 MB，ad-hoc 签名，未公证）

- 校验（`latest-mac.yml` 里记录的期望值）：
  - `.dmg` sha512 `S8bpvkyc46…` / 126257707 字节
  - `.zip` sha512 `QHWezs5m…` / 138598248 字节

## 0. 前置

- Apple Silicon Mac，macOS 14+（Intel 机型不适用，本包只有 arm64）
- 至少装一个可用引擎 CLI：`claude` / `opencode` / `qwen` 之一（在 **终端** 里 `which` 能确认）

## 1. 打开（Gatekeeper 第一次会拦，属预期）

```bash
# 二选一：
open nexus-0.3.3-arm64.dmg        # 双击，拖 nexus 进 /Applications，右键 → 打开
# 或清隔离属性：
xattr -dr com.apple.quarantine /Applications/nexus.app
```

## 2. 启动 ★ 必须从 Finder 双击

**不要**用 `open` / `./nexus.app/Contents/MacOS/nexus` 从终端启动——终端会把你 shell 的
PATH（含 `/opt/homebrew/bin`）传给 app，把本清单真正要验证的 bug 遮住。

启动后等几秒，然后确认：

- [ ] 窗口渲染正常（不白屏 / 不闪退）
- [ ] 菜单栏有 App / Edit / Window，Cmd+C / Cmd+V / Cmd+Q 生效
- [ ] 设置页能进，会话列表能渲染

## 3. 日志确认 ★ 核心断言

等 10 秒左右，看应用日志（macOS 上 Electron 写到
`~/Library/Application Support/nexus/logs/`，找不到就从 app 里复制路径贴到 Terminal 看）：

- [ ] 出现 **`Nexus core initialized`**（= worker 起来了 = `node` 找到了 = SQLite 打开了）

**如果没有这条**，大概率是 PATH 问题：

```bash
# 从 Finder 启动的 app 只能看到 /usr/bin:/bin:/usr/sbin:/sbin，
# 检查 node 实际在哪：
which node
```

| `which node` 输出 | 结论 |
|---|---|
| `/opt/homebrew/bin/node` / `/usr/local/bin/node` / nvm 路径 | PATH bug 实锤，app 里 spawn `node` 会失败 |
| `/usr/bin/node`（系统官方） | 不是 PATH 问题，看日志里的其他报错 |

## 4. 功能

- [ ] 配好 API key（设置 → Provider）
- [ ] 跑通一次 agent turn（顺带验 `git` / `claude` 等 CLI 能不能被 app 调起）
- [ ] `ls ~/.nexus` 有 `sessions.db`、`logs/` 等目录

## 5. 退出

Cmd+Q 正常退出，再看一眼
`~/Library/Application Support/nexus/` 有 `sessions/`、`logs/`、`keychain/` 等目录。

## 报告

按 2 / 3 / 4 / 5 逐项打勾或贴出实际输出（带日志片段），特别是第 3 项
（有没有 `Nexus core initialized` + `which node` 的结果）。
