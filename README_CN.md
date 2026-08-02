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
- **MCP 工具**：连接外部 MCP 服务器获取专业能力；内置工具优先于 MCP 同名工具；30 秒超时，卡死服务器自动重连
- **路径授权**：提示/允许/拒绝，支持按会话（`y`）和持久化（`a`）授权，缓存于 `path-auth.json`；提前 `existsSync` 检查避免不存在的文件弹出授权提示
- **斜杠命令**：`/model`, `/provider`, `/session`, `/resume`, `/memory`, `/insight`, `/tools`, `/skills`, `/config`, `/clear`, `/exit`, `/plan`, `/tasks`, `/btw`, `/theme`
- **技能/插件**：从 `~/.nexus/skills/` 动态加载，无效技能目录自动生成降级
- **ACP 协议**：基于 WebSocket 的智能体间通信
- **差异渲染器**：LLM 响应的彩色内联差异输出
- **视觉/多模态**：`analyze_image` 工具支持本地 (Florence-2) 和云端视觉提供商 (GLM-4V, Agnes-2V 等)，可配置回退模式
- **任务 DAG 引擎**：将请求分解为 3-5 个子任务，带依赖解析执行，支持 `new`（绿地）和 `modify`（修改现有）模式，自动 git 快照与回滚安全
- **临时文件清理**：任务结束后清理探测/暂存/缓存文件，将交付物收集到沙箱输出目录
- **权限白名单**：预授权工具（`/bypass`）、按路径范围的 exec 自动放行（`safePaths`），以及 `edit` 预设，让 vibe-coding 会话不再被逐个工具弹窗打断。`/go` 在执行计划期间临时启用白名单，结束后自动恢复
- **数据脱敏**：文件读取内置脱敏——经纬度坐标随机偏移（保留数值形态，便于下游处理与调试代码），敏感字段（密码/令牌/密钥/账号）掩码为 `***REDACTED***`，错误信息中的敏感路径隐藏；API 密钥使用 AES-256-GCM 静态加密或通过 `$VAR`/`env:VAR` 引用解析，确保无明文密钥进入上下文或磁盘

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
- `/bypass [auto|off|status]` - 切换权限白名单（auto = 免确认编辑模式，off = 每个工具执行前询问）
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

### 权限白名单

权限系统分为三级：`Allow`（永不询问）、`Prompt`（询问用户）、`Deny`（始终拒绝）。默认情况下，所有修改类工具都是 `Prompt`，即代理在每次操作前都会询问。白名单用于预授权工具，让 vibe-coding 会话不被打断地连续运行。

**会话级缓存：** 在 `auto` 模式（白名单启用）下，用户批准某个工具后，同会话内后续调用该工具自动放行，不再重复询问。缓存在 nexus 重启时清空。

**三套相互独立的机制：**

1. **工具名白名单（`/bypass`）** —— 控制*某个工具是否会被询问*。
   ```bash
   /bypass on        # 启用白名单（auto 模式）；若无白名单则自动套用 "edit" 预设
   /bypass off       # 恢复 prompt 模式（每个工具都询问）
   /bypass status    # 显示当前模式与白名单
   ```
   通过 CLI 持久化管理：
   ```bash
   nexus config permissions preset edit   # 用读写文件工具填充白名单
   nexus config permissions enable         # 切换到 auto 模式
   nexus config permissions disable        # 恢复 prompt 模式
   nexus config permissions add <tool...>  # 增加指定工具
   nexus config permissions remove <tool...>
   nexus config permissions list
   ```

2. **exec 路径白名单（`safePaths`）** —— 按命令的*工作目录*控制 *`exec_command` 是否会被询问*。在安全路径内运行的命令自动放行（危险命令除外）。默认安全路径：`~/.nexus/tasks` 和 `.`（代理启动目录 / pwd）。`~` 展开为用户主目录。
   ```bash
   nexus config permissions path list
   nexus config permissions path add <path...>
   nexus config permissions path remove <path...>
   ```

3. **路径授权（`path-authorizer`）** —— 独立的安全层，控制*某个目录是否允许访问*。首次访问新目录时总会提示，并记住授权（`y` 本次 / `a` 始终）。它与白名单无关，且不会被绕过。

**`/go` 集成：** 运行 `/go` 执行计划时，白名单会在执行期间临时切换为 auto（若未配置白名单则套用 `edit` 预设），执行结束后恢复为你持久化的设置——该临时变更**不会写入磁盘**。

> 危险命令（`rm -rf /`、`mkfs` 等）和破坏性工具（`delete_file`、`remove_file`）无论白名单状态如何，始终被拦截。

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

## OCR（文字提取）

`ocr_extract` 工具从图片中提取文字（截图、文档、终端输出、表单、幻灯片）。支持云端 API 和本地 OCR 提供商。

### 云端 OCR 提供商

```bash
# 配置云端 OCR（如 DeepSeek OCR via ModelVerse）
nexus config ocr set ds-ocr2 -t openai-compatible \
  -k $API_KEY_DSOCR \
  -u https://api.modelverse.cn/v1/chat/completions \
  -m deepseek-ai/DeepSeek-OCR

# 列出提供商
nexus config ocr list

# 切换活跃提供商
nexus config ocr switch ds-ocr2
```

### 本地 OCR（PaddleOCR 便携版）

独立 **PaddleOCR** 可执行文件（`paddle-ocr.exe`，约 90MB），无需 API 密钥即可离线 OCR。基于 RapidOCR + ONNX Runtime，内置 PP-OCRv6 模型。

**下载：** [paddle-ocr.exe — nexus-extensions](https://github.com/jsws9517/nexus-extensions)

```bash
# 配置 nexus 使用本地便携 OCR
nexus config ocr set paddle-local -t paddleocr \
  --command "C:\path\to\paddle-ocr.exe"

# 设为活跃（本地优先，API 作为回退）
nexus config ocr switch paddle-local
```

**独立使用：**

```bash
paddle-ocr.exe --image screenshot.png                    # JSON 输出
paddle-ocr.exe --image photo.jpg --lang en --output text # 纯文本
paddle-ocr.exe --image doc.png --show-boxes              # 含置信度
paddle-ocr.exe --version                                 # 版本信息
```

## 语音 / 音频

智能体支持**语音转文字（STT）**和**文字转语音（TTS）**，通过统一的 `speechProviders` 配置管理。每个提供商通过 `category` 字段（`stt` 或 `tts`）指定角色。

### STT — 语音转文字（transcribe_audio）

使用 `transcribe_audio` 工具将音频文件（会议录音、语音消息、讲座）转写为文字。

```bash
# 配置 STT 提供商（阿里云 DashScope ASR）
nexus config speech set asr-qwen \
  -k $API_KEY_ALIYUN \
  -u https://dashscope.aliyuncs.com/compatible-mode/v1 \
  -m qwen3-asr-flash \
  -c stt

# 或使用 SiliconFlow（TeleSpeechASR）
nexus config speech set asr-tel \
  -k $API_KEY_SILICON \
  -u https://api.siliconflow.cn/v1 \
  -m TeleAI/TeleSpeechASR \
  -c stt

# 列出已配置的提供商
nexus config speech list

# 设置活跃 STT 提供商
nexus config speech switch asr-qwen
```

### TTS — 文字转语音（synthesize_speech）

使用 `synthesize_speech` 工具将文字转为语音。支持 OpenAI 兼容的 TTS API 和本地提供商。

```bash
# 配置云端 TTS 提供商（OpenAI 兼容）
nexus config speech set openai-tts \
  -k $API_KEY_OPENAI \
  -u https://api.openai.com/v1 \
  -m tts-1 \
  -c tts \
  --voice alloy

# 配置本地 Kokoro TTS（无需 API 密钥）
nexus config speech set kokoro \
  -k dummy \
  -u http://localhost:8181/v1 \
  -m kokoro \
  -c tts \
  --voice af_sky

# 设置活跃 TTS 提供商
nexus config speech switch-tts kokoro
```

### 支持的音频格式

`transcribe_audio` 接受：`wav`、`mp3`、`m4a`、`ogg`、`flac`、`webm`、`aac`、`wma`。

## ACP 协议

Nexus 实现了 **智能体间通信协议（ACP）**——一种基于 stdin/stdout 的 JSON-RPC 2.0 传输协议。cc-connect（飞书、微信、Telegram 等平台的中继桥接器）使用该协议将用户消息转发给智能体，并流式返回响应。

### ACP 超时设置

长时间运行的任务（MCP 工具调用、缓慢的模型响应）可能导致传输通道卡死。三个可配置参数保障会话存活：

| 参数 | 默认值 | 说明 |
|-----------|---------|------|
| `chunkIdleMs` | 60000 | 逐块空闲保护——若在此时间内无新数据块到达，则中止 LLM 流 |
| `watchdogRemoteMs` | 90000 | 整轮超时——若整个轮次超过此时间，进程退出（核弹级兜底） |
| `heartbeatMs` | 30000 | 心跳间隔——定期发送 `session/update { heartbeat }` 通知给 cc-connect，让传输层知道智能体在长时间工具调用期间仍在工作 |

**建议保持 `watchdogRemoteMs ≥ 3× heartbeatMs`**，确保截止时间前能发出多次心跳。

```bash
# 查看当前值（含来源：config / env / default）
nexus config acp timeout list

# 设置自定义值
nexus config acp timeout set heartbeatMs 10000
nexus config acp timeout set watchdogRemoteMs 60000

# 重置为默认值
nexus config acp timeout reset chunkIdleMs

# 环境变量覆盖（最高优先级）：
#   NEXUS_CHUNK_IDLE_TIMEOUT_MS
#   NEXUS_WATCHDOG_REMOTE_MS
#   NEXUS_HEARTBEAT_INTERVAL_MS
```

ACP 服务器在每个轮次中每隔 `heartbeatMs` 发送一次**心跳**。如果 cc-connect 在其自身连接超时内未收到任何数据，它会断开会话；心跳正好填补这一空白。如果轮次卡住超过 `watchdogRemoteMs`，智能体进程将干净退出，cc-connect 会为下一条消息启动一个新实例。

## 近期更新 (v1.1.7+)

### 新特性

- **会话级工具审批缓存**：在 `auto` 模式下，用户批准某个工具（如 `file_write`）后，同会话内后续调用该工具自动放行，不再重复询问。缓存在 nexus 重启时清空。消除 vibe-coding 会话中反复出现的 `Allow tool "..."?` 提示
- **MCP 工具超时与自动重连**：所有 MCP 工具调用设有 30 秒超时。服务器卡死时调用优雅失败，卡死的服务器自动断开连接——下次调用触发全新重启。防止无响应的 MCP 服务器导致无限挂起
- **记忆服务器超时处理**：知识图谱操作（`remember`、`saveUserInfoIfNeeded`）现在能检测服务器超时并返回可操作的错误信息（如 `taskkill /f /im uv.exe`），不再无限挂起
- **记忆工具权限默认值**：`recall` 始终允许（只读）；`remember` 和 `remember_project` 默认为 `Prompt`——与其他写操作一致
- **cc-connect 原生文件推送**：自动检测生成的文件（图片、PDF 等），通过 `cc-connect send --image` CLI 原生推送到 IM 平台（Telegram、飞书、微信），Cloudinary URL 作为文本回退
- **ACP 打字指示器**：LLM 处理期间每 5 秒发送实时打字指示器（`session/update { typing }`），让消息桥接器显示"正在输入..."状态
- **ACP 权限协议**：工具权限请求（`session/request_permission`）通过 ACP 转发给 cc-connect 进行用户审批，支持 `allow`/`deny` 判决，超时 2 分钟
- **ACP 调试开关**：通过 ACP 配置（`nexus config acp debug on/off`）切换调试日志，不再需要环境变量
- **配置 Web UI**：浏览器配置面板（`nexus config web`），管理提供商、MCP 服务器、权限和质量门禁
- **i18n 双语支持**：中英文双语支持，`/lang` 命令切换，欢迎界面和帮助输出双语显示
- **单键权限提示**：紧凑权限提示，支持自动提交（`y`/`a`/`n` 无需回车），提升 vibe-coding 流畅度
- **MCP 工具白名单**：通过 `/bypass` 命令预授权 MCP 工具，Web UI 权限面板可视化管理
- **数据脱敏**：`read_text_file` / `read_multiple_files` 自动脱敏——经纬度坐标随机偏移（约 1km，保留数值形态，生成的调试/处理代码仍可用），敏感字段（password/token/key/账号/私钥）掩码为 `***REDACTED***`；`read_multiple_files` 限制最多 100 个路径、单文件 100KB，防止上下文溢出
- **API 密钥加密**：`config.json` 中明文的提供商/MCP 密钥在启动时自动加密为 `enc:` AES-256-GCM 密文；MCP 服务器 `env` 值支持 `enc:` 密文和 `$VAR` / `env:VAR` 引用（仅含 KEY 的变量自动加密），即使绕过 CLI/Web UI 直接改文件，磁盘上也无明文密钥

### 缺陷修复

- **安全加固**：审计修复 22+ 项——
  - **认证与 ACP**：token 常量时间比较、MCP 错误转储打码凭证
  - **命令与路径安全**：拦截所有解释器/shell 与网络外泄工具、目录安装加 `--ignore-scripts`、路径授权按请求作用域隔离避免进程级累积、符号链接逃逸防护、拦截 Windows 设备路径（CON/NUL）
  - **Web UI**：DELETE 路径 `decodeURIComponent`、XSS 转义、移除未认证的 bootstrap 接口、配置展示 API 密钥掩码
  - **文件工具**：`read_multiple_files` 限制（100 路径 / 100KB）、JSON.parse 加 try/catch、扩展敏感路径脱敏
- **ESM Require 崩溃**：修复权限模块 ESM 导入崩溃和 PageUp 回放注入计划块
- **权限提示修复**：修复按键重复回显、单键提示挂起/重复、y/N 提示不接受输入
- **工具调用显示**：修复脆弱的 `\r` 就地更新，限制预览宽度，`agent>` 提示独占一行
- **技能创建器修复**：修复技能创建流程中的双回显、挂起和去重问题
- **配置 Web UI**：修复提供商删除未持久化（缺少 `config.save()`）
- **子 agent 权限**：修复工作模式下父权限模式未传递给子 agent
- **会话持久化**：修复删除含 task_graphs 的会话时 FOREIGN KEY 约束失败
- **ACP 传输**：修复消息随机长度丢失和 JSON-RPC `-32603: Invalid string length`

## 许可证

ISC
