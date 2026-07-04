# LLM-Agent 功能测试指南

## 测试范围

本测试套件覆盖以下核心模块的功能验证：

| 模块 | 测试文件 | 验证内容 |
|------|---------|---------|
| MCP 内置工具 | `tests/builtin-tools.test.ts` | file_read, file_write, exec_command, fetch_url |
| MCP 客户端管理 | `tests/mcp-client.test.ts` | 工具注册、调用、连接管理 |
| Skills 系统 | `tests/skills.test.ts` | 技能加载、注册表、工具暴露 |
| 上下文管理 | `tests/context-manager.test.ts` | 消息序列、assistant+tool 对完整性 |

## 执行方式

```bash
# 开发模式（直接运行 TS）
npm run test:dev

# 生产模式（运行编译后的 JS）
npm run build && npm test
```

## 测试提示词（Prompts for Validation）

### 1. MCP 内置工具验证提示词

```
请执行以下验证步骤，确认 MCP 内置工具功能正常：

1. file_read 工具
   - 验证能读取 package.json 并返回正确内容
   - 验证对不存在的文件返回 isError=true
   - 验证空路径返回错误

2. file_write 工具
   - 验证能写入文件并随后读取内容一致
   - 验证空内容写入不报错

3. exec_command 工具（重点：安全防护）
   - 验证 `echo hello` 正常执行
   - 验证 `rm -rf /` 被拦截（blocked）
   - 验证 `echo $(whoami)` 被拦截（subshell）
   - 验证 `bash -c "echo x"` 被拦截（inline interpreter）
   - 验证 timeout 参数生效（500ms 超时）

4. fetch_url 工具（重点：SSRF 防护）
   - 验证 httpbin.org/get 可正常访问
   - 验证 localhost 被拦截
   - 验证 192.168.x.x 被拦截
   - 验证 127.0.0.1 被拦截
   - 验证 file:// 协议被拦截

5. 元数据检查
   - 所有工具名称唯一
   - 所有工具都有 inputSchema 和 description
```

### 2. Skills 系统验证提示词

```
请执行以下验证步骤，确认 Skills 系统功能正常：

1. SkillRegistry
   - 初始状态为空（list() 返回空数组）
   - load() 能从 ~/.llm-agent/skills/ 加载技能
   - reload() 能重新加载
   - getTools() 汇总所有技能的 tools

2. 技能类型支持
   - JS 技能模块（index.js/index.mjs/skill.js）
   - CJS 技能模块（通过 createRequire）
   - Claude Code SKILL.md 技能（prompt-based）

3. 边界情况
   - 技能目录不存在时不崩溃
   - 损坏的技能模块被静默跳过
   - handleCommand 对不存在的技能返回 undefined
```

### 3. Context Manager 验证提示词

```
请执行以下验证步骤，确认上下文管理功能正常：

1. 基本操作
   - add/getMessages 正常工作
   - clear 清空所有消息
   - setMessages 替换并清除 pinned 状态

2. 消息限制（enforceLimits）
   - 超过 maxMessages 时自动删除最旧的消息
   - pinned 消息不会被删除
   - 删除包含 toolCalls 的 assistant 时，**必须同时删除对应的 tool messages**

3. assistant+tool 对完整性（关键）
   - 场景：assistant 包含 2 个 toolCalls，后面跟着 2 个 tool messages
   - 当 trimming 发生时，这 3 条消息必须作为一个整体被删除
   - 不允许出现"tool message 前面没有对应 assistant"的情况
   - 这是 OpenAI API 的硬性要求，违反会导致 400 错误

4. Token 估算
   - getTokenCount 返回正值
```

### 4. Agent 端到端验证提示词

```
请执行以下端到端验证：

1. 启动会话
   - agent chat 模式正常启动
   - 能发送消息并接收回复

2. 工具调用链
   - 发送需要工具调用的 prompt
   - 验证 assistant message 正确包含 toolCalls
   - 验证 tool messages 紧随其后
   - 验证 tool results 被送回 LLM 后得到最终回复

3. 多轮工具调用
   - 一轮对话触发多次 tool call
   - 所有 tool call 执行完毕后才重新调用 LLM
   - 最终结果包含所有工具结果的综合

4. 模式切换
   - Ctrl+O 切换 detailMode
   - 精简模式只显示最近 4 轮推理
   - 完整模式显示所有输出
   - 推理过程中切换模式不中断当前轮次
```

## 已知问题记录模板

发现问题时，按以下格式记录：

```markdown
### Issue #N: [标题]
- **模块**: [builtin-tools | mcp-client | skills | context-manager | agent | chat-cli]
- **严重程度**: [Critical | High | Medium | Low]
- **复现步骤**: 
  1. ...
  2. ...
- **预期结果**: ...
- **实际结果**: ...
- **根因分析**: ...（如已定位）
- **修复建议**: ...（如已有方案）
```

## CI/CD 集成

- GitHub Actions: `.github/workflows/ci.yml`
- Gitee CI: `.gitee-ci.yml`
- 测试在 Node 20.x 和 22.x 上运行
- 每次 push 到 main/dev 或 PR 时自动触发
