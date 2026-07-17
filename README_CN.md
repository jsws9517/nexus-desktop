# NexusAgent

一个强大的 TypeScript CLI 智能体，连接多种 LLM 提供商、MCP 工具、文件系统自动化、技能/插件系统和 ACP 协议——开发工作流的智能中枢。

## 特性

- **多提供商 LLM 支持**：Anthropic (Claude) 和 OpenAI (GPT) 轻松切换，CLI 可配置
- **OpenCode Zen 集成**：一键认证流程接入精选 OpenCode Zen 网关（`nexus config opencode-zen login`）
- **会话管理**：SQLite 持久化聊天会话，跨进程恢复，`/resume` 浏览历史
- **长上下文处理**：滑动窗口 + 自动摘要 + 上下文压缩
- **每会话持久记忆**：自动记忆摘要按会话持久化，`/memory` 查看，`/insight` 跨会话分析
- **丰富交互式聊天**：流式输出带渐变分隔线，会话报告，`/history` 浏览，PageUp 翻页
- **内置文件系统工具**：完整文件读写/编辑/移动/复制/删除/目录树——无需外部 MCP 服务器
- **MCP 工具**：连接外部 MCP 服务器获取专业能力；内置工具优先于 MCP 同名工具
- **路径授权**：提示/允许/拒绝，支持按会话（`y`）和持久化（`a`）授权，缓存于 `path-auth.json`；提前 `existsSync` 检查避免不存在的文件弹出授权提示
- **斜杠命令**：`/model`, `/provider`, `/session`, `/resume`, `/memory`, `/insight`, `/tools`, `/skills`, `/config`, `/clear`, `/exit`, `/plan`, `/tasks`, `/btw`, `/theme`
- **技能/插件**：从 `~/.nexus/skills/` 动态加载，无效技能目录自动生成降级
- **ACP 协议**：基于 WebSocket 的智能体间通信
- **差异渲染器**：LLM 响应的彩色内联差异输出
- **视觉/多模态**：`analyze_image` 工具支持本地 (Florence-2) 和云端视觉提供商 (GLM-4V, Agnes-2V 等)，可配置回退模式
- **任务 DAG 引擎**：将请求分解为 3-5 个子任务，带依赖解析执行，支持 `new`（绿地）和 `modify`（修改现有）模式，自动 git 快照与回滚安全
- **临时文件清理**：任务结束后清理探测/暂存/缓存文件，将交付物收集到沙箱输出目录

## 安装

```bash
npm install
npm run build
npm link  # 或 npm install -g
```

## 配置

配置文件自动创建于 `~/.nexus/config.json`：

```bash
# 列出配置
nexus config list

# 设置 API 密钥
nexus config set provider.anthropic.apiKey YOUR_KEY

# 切换提供商
nexus config switch openai

# 添加 MCP 服务器（文件系统工具已内置；外部 MCP 用于自定义服务）
nexus config mcp add my-service --command node --args path/to/server.mjs
```

## 使用

```bash
# 交互式聊天
nexus
nexus chat

# 恢复会话
nexus chat --session <id>

# 单次提示
nexus run "解释量子计算"

# 会话管理
nexus session list
nexus session resume <id>
nexus session rename <id> <name>
nexus session delete <id>
```

## 交互命令

聊天中键入：

- `/help` - 显示命令
- `/session` - 显示当前会话信息
- `/resume <id>` - 恢复历史会话
- `/view [id|#]` - 浏览会话原始消息
- `/delete` - 删除会话
- `/rename <名称>` - 重命名当前会话
- `/memory` - 查看当前会话持久记忆
- `/insight` - 跨会话记忆分析
- `/model` - 显示/切换 LLM 模型
- `/provider` - 显示/切换 LLM 提供商
- `/compact` - 压缩当前会话上下文
- `/new` - 压缩历史并开始新会话
- `/clear` - 清除上下文（重新开始）
- `/plan <请求>` - 将请求分解为 DAG 子任务（支持 `@path` 解析）
- `/go` - 执行当前计划
- `/tasks [id]` - 显示任务图或详细步骤信息（隐式 `-step`）
- `/tools` - 列出可用工具
- `/mcp` - 列出 MCP 服务器连接
- `/skills` - 管理技能插件（列出、重载、创建、验证、修复、智能修复）
- `/plugins` - 列出已加载的插件
- `/btw <信息>` - 在下次 LLM 调用前注入上下文
- `/theme` - 显示/切换颜色主题
- `/flush` - 清除屏幕
- `/config` - 查看/编辑配置
- `/exit`、 `/quit` - 退出

## 开发工作流（质量门禁）

Nexus 内置两个编程子 agent——**Tester**（测试）和 **Committer**（提交）——可按需或自动串联，形成 `实现 → 测试 → 提交` 流水线。

子 agent 能力边界：
- **Tester**：只读。自动探测并运行项目测试/lint/类型检查，输出 `VERDICT: PASS` 或 `VERDICT: FAIL`。绝不修改源码或提交。
- **Committer**：审查 `git diff`，运行测试/构建，然后使用 Conventional Commits 风格创建**本地**原子提交。**绝不 `git push`**。

### 启用质量门禁

**1. 全局配置开关——自动流水线**

在 `config.json`（或 Web 面板 General 区）中配置：

```json
{
  "qualityGate": {
    "autoTest": true,    // 默认 true：实现任务完成后自动运行 Tester
    "autoCommit": false  // 默认 false：不自动提交，需手动确认
  }
}
```

- `autoTest=true`：每次 `file_write`/`file_edit` 后触发 `npm run test`（当项目有 `test` 脚本时）。实现类任务（`agentHint=general` 的 DAG 节点或 `spawn_subagent` 的 general 角色）完成后自动派生 Tester 子 agent。
- `autoCommit=true`：仅当 Tester 输出 `VERDICT: PASS` 时，派生 Committer 子 agent 创建本地提交。**默认关闭**以避免意外提交。

Web 面板开关：`Quality Gate: Auto-Test` / `Quality Gate: Auto-Commit`。
CLI：`nexus config` 交互编辑（或 `nexus config web`）。

**2. 按任务按需开启——绕过全局配置**

- **显式工具调用**：随时调用 `spawn_tester`（只读测试）或 `spawn_committer`（审查+提交），无需修改配置。
- **计划任务角色标注**：`/plan` 分解为 DAG 后，为任一节点标注 `agentHint: tester` 或 `agentHint: committer`。DAG 调度器按对应角色执行，无视 `autoTest`/`autoCommit` 设置。
- `spawn_subagent` 支持 `agent_type: general | tester | committer` 参数选择角色。

### 推荐用法

| 场景 | 配置 | 行为 |
| --- | --- | --- |
| 默认（回归保护） | `autoTest:true, autoCommit:false` | 编码时自动测试；提交由你确认 |
| 全自动 | `autoTest:true, autoCommit:true` | 测试通过后自动本地提交 |
| 单次精细控制 | 不改 config | 直接使用 `spawn_tester`/`spawn_committer` 或标注 DAG 节点 |

### 任务 DAG 模式

`/plan` 将请求分解为 3-5 个子任务，两种模式：

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| `new` | 无 `@path` 引用 | 所有文件写入 `~/.nexus/tasks/outputs/<project>/` 沙箱 |
| `modify` | 请求包含 `@path` 文件引用 | 原地编辑现有文件；完成后自动创建 git 快照（`git add -A && git commit`）用于回滚 |

DAG 执行后自动运行 **finalize**：清理临时文件（`_probe`、`__pycache__`、`.pytest_cache`、`dist`、`build` 等），收集交付物，生成 `.task-complete.json` 报告。

### 性能优化

- 子 agent `maxTurns` 减少：General 10→6、Tester 8→4、Committer 6→4——减少无效轮次
- 任务最大重试次数从 2 减为 1
- `src/mcp/client-manager.ts`：工具名去重——内置工具优先于 MCP 同名工具
- MCP 工具调用前执行 `existsSync` 检查——避免为不存在的文件弹出授权提示

### 安全约束

- 测试失败或 Tester 出错时，自动提交链**中止**——不会提交未经验证的代码。
- Tester 只读（仅 `exec_command` 用于测试）；Committer 仅做本地 `add`+`commit`，绝不 push。
- `modify` 模式的 git 快照仅本地提交，绝不 push。
- 相关源码：`src/config/index.ts`（`getQualityGate`/`setQualityGate`）、`src/task/task-tools.ts`（`runQualityGate`）、`src/task/sub-agent-roles.ts`（角色定义）、`src/hooks/auto-validate.ts`（写文件时自动测试）、`src/task/dag-scheduler.ts`（finalize/snapshot）。

## 技能

技能模块放置在 `~/.nexus/skills/`。每个技能可以是 **JS 模块**或 **markdown 提示**（`SKILL.md`）。

### SKILL.md（基于提示的技能）

```
~/.nexus/skills/<技能名称>/
├── SKILL.md             # 带 YAML frontmatter 的技能提示
├── evals/evals.json     # 可选测试用例
└── ...                  # 支持文件
```

Frontmatter 格式：

```yaml
---
name: my-skill
version: 1.0.0
description: 一行描述技能功能
---
```

正文包含详细的 markdown 指令和工具使用示例。技能在启动时和 `/skills reload` 时加载。

### JS 模块技能

```javascript
// ~/.nexus/skills/my-skill.js
export default {
  name: 'my-skill',
  version: '1.0.0',
  tools: [
    {
      name: 'my_tool',
      description: '做某事',
      inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
    }
  ],
  async handleCommand(cmd, args) {
    return `处理: ${cmd}`;
  }
};
```

### 技能管理命令

聊天中使用 `/skills` 管理技能：

| 命令 | 说明 |
|---------|------|
| `/skills list` | 列出所有已加载技能 |
| `/skills reload` | 从磁盘重新加载所有技能 |
| `/skills create <名称>` | 交互式创建新技能——依次提示输入描述与多行指令（以 `---` 或 Ctrl+Z 结束输入） |
| `/skills validate <名称>` | 验证技能结构（frontmatter、正文长度、工具引用、semver 等） |
| `/skills fix <名称>` | 自动修复常见问题（缺失字段、旧路径、缺失 README/CHANGELOG/evals） |
| `/skills fix-smart <名称>` | 派生子 agent 智能修复复杂问题 |

**Skill Fixer 子 agent**（`fix-smart`）使用 LLM 完成：
- 将 YAML 块标量转换为内联描述
- 添加带 `call`/`invoke` 前缀的工具使用示例
- 将 `~/.claude/skills/` 路径更新为 `~/.nexus/skills/`
- 用有意义的指令扩充简短正文
- 创建或填充 `evals/evals.json` 占位测试用例

## 开发

```bash
npm run dev        # 使用 tsx 运行
npm run build      # 编译 TypeScript
npm run typecheck  # 类型检查 (tsc --noEmit)
npm test           # 运行所有单元测试
```

## 视觉 / 多模态

智能体可以使用**本地模型**（Florence-2）或**云端视觉 API**（GLM-4V、Agnes-2V 等）分析图像。回退行为由 `visionMode` 设置控制。

### 视觉模式

| 模式 | 行为 |
|------|------|
| `local-first`（默认） | 先尝试本地 Florence-2；失败时回退到云端 |
| `cloud-first` | 先尝试活跃云端提供商；失败时回退到本地 |
| `local-only` | 仅使用本地 Florence-2（无云端调用） |
| `cloud-only` | 仅使用活跃云端提供商（无本地调用） |

```bash
# 显示当前模式
nexus config vision-mode list

# 更改模式
nexus config vision-mode set local-only
nexus config vision-mode set cloud-first
```

## OpenCode Zen

OpenCode Zen 是由 OpenCode 团队运营的精选 **Anthropic 兼容**模型网关。认证后，Nexus 将其视为其他 Anthropic 提供商一样使用（`claude-opus-4-6`、`claude-sonnet-4-6`、`big-pickle`、`minimax-m2.5-free` 等）。访问 <https://opencode.ai/docs/zen/> 查看当前模型列表和定价。

```bash
# 交互式登录——打开 https://opencode.ai/auth 并保存 API 密钥
nexus config opencode-zen login

# 或非交互式（用于 CI/脚本）：
nexus config opencode-zen login --key sk-... --use

# 显示密钥来源（存储的密钥 vs $OPENCODE_API_KEY）
nexus config opencode-zen status

# 激活 Zen（默认使用存储的密钥）
nexus config opencode-zen use

# 切换到特定模型（并激活）
nexus config opencode-zen use claude-sonnet-4-6
nexus config opencode-zen use big-pickle

# 仅更改模型，保持当前提供商
nexus config opencode-zen use claude-opus-4-6 --no-switch

# 列出精选模型
nexus config opencode-zen models

# 移除存储的密钥
nexus config opencode-zen logout
```

底层将提供商条目写入 `~/.nexus/config.json`：

```json
{
  "providers": {
    "opencode-zen": {
      "type": "anthropic",
      "apiKey": "<encrypted>",
      "baseUrl": "https://opencode.ai/zen",
      "model": "claude-sonnet-4-6"
    }
  }
}
```

运行时若设置了 `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` 环境变量，则优先使用，无需再次登录。共享/CI 环境推荐使用环境变量。

### 本地视觉设置

需要 **Python 3.10+**，带 PyTorch 和 Transformers。

运行设置脚本以创建 `.venv`、安装依赖并预下载 Florence-2 模型：

```powershell
# 默认（直接 HuggingFace）
.\scripts\setup-vision.ps1

# 中国用户使用 HF 镜像
.\scripts\setup-vision.ps1 -Mirror hf-mirror.com -PypiMirror https://pypi.mirrors.ustc.edu.cn/simple
```

智能体自动检测项目 `.venv` 中的 Python。要使用自定义 Python 路径，设置：

```bash
set LLMA_VISION_PYTHON=C:\path\to\python.exe
```

### 云端视觉提供商

配置云端视觉提供商（如智谱 GLM-4V、Agnes-AI Agnes-2V）：

```bash
# 添加提供商（API 密钥可引用环境变量）
nexus config vision set glm-4v ^
  -k $ZHIPU_KEY ^
  -u https://open.bigmodel.cn/api/paas/v4/chat/completions ^
  -m glm-4v-flash

# 列出已配置的提供商
nexus config vision list

# 切换活跃提供商
nexus config vision use glm-4v

# 移除提供商
nexus config vision remove glm-4v
```

### Cloudinary 图片上传

云端视觉提供商通常需要公开可访问的图片 URL。智能体在发送到云端 API 之前将本地图片上传到 Cloudinary。设置以下环境变量：

```bash
set CLOUDINARY_CLOUD_NAME=your_cloud
set CLOUDINARY_API_KEY=your_key
set CLOUDINARY_API_SECRET=your_secret
```

图片在分析后自动从 Cloudinary 清理。

## 许可证

ISC
