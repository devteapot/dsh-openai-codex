# @devteapot/dsh-openai-codex

[English](README.md) | 中文

面向 harness LLM seam 的 ChatGPT Plus/Pro OAuth 适配器。一个插件实例拥有 `openai-codex` 提供方路由，把 OAuth 会话存在一条凭据引用下，并通过 pi-ai 的 Codex catalog 提供方发流。登录、刷新与登出留在本包，以便 `@deepseek-ai/dsh-llm-pi-ai` 继续只处理密钥加端点的 profile。

包根入口导出 Cordis 插件约定、`OpenAiCodexAdapter`、`OpenAiCodexAuth`（`ctx.openaiCodex`）、`createCodexModels` 以及 OAuth 存储辅助函数。历史与事件转换复用 `dsh-llm-pi-ai` 的 `./conversion` 子路径所导出的 `toPiContext` / `toStreamChunks`。

## 安装

此开发版本要求 DeepSeek Harness 同步加入 `@deepseek-ai/dsh-llm-pi-ai/conversion` 导出。目前尚无已发布的 harness 构建提供该子路径；peer 版本范围从预期的 `0.1.0-rc.7` 开始，使不兼容的安装在依赖解析时失败，而不是运行时失败。

把固定到特定提交的版本安装进 profile：

```sh
dsh plugin --profile web add github:devteapot/dsh-openai-codex#<commit>
```

Git 依赖会运行本仓库的 `prepare` 构建。pnpm 10 及更高版本会先要求明确授权。如果首次安装报告构建被阻止，请把它打印的准确包键加入 `$DSH_HOME/profiles/web/pnpm-workspace.yaml`，然后重试上述命令：

```yaml
allowBuilds:
  '@devteapot/dsh-openai-codex': true
```

本包声明了 `dsh.bundle`，因此 `dsh plugin add` 会在 profile 清单中跟踪它并应用 `cordis.patch.yml`。可用 `dsh plugin --profile web remove @devteapot/dsh-openai-codex` 删除。

## 配置

```yaml
- id: llm-openai-codex
  name: '@devteapot/dsh-openai-codex'
  config:
    oauthEnv: OPENAI_CODEX_OAUTH  # default; resolved per request via ctx.credentials, then the environment
    displayName: OpenAI Codex     # optional selector label
    reasoning: high               # optional; off | minimal | low | medium | high | xhigh | max
    streamIdleTimeoutMs: 300000   # optional; five-minute default
    retryPolicy:                  # optional; omission uses bounded normal defaults
      mode: normal
      maxRetries: 3
```

在被引用的凭据写入一份 JSON OAuth 会话（`type`、`access`、`refresh`、`expires`）之前，该路由保持**休眠**。`/codex-login` 与 `ctx.openaiCodex.login(interaction)` 会持久化该会话；`/codex-logout` 与 `ctx.openaiCodex.logout()` 会删除它。pi-ai 在下一次请求时于存储锁下刷新即将过期的 token。未登录时发出的请求以 `NO_ADAPTER` 失败，因为路由尚未注册；`MISSING_CREDENTIAL` 留给无法持久化会话的登录（没有凭据服务）。

`oauthEnv` 是凭据*引用*。settings 文档从不保存 token。未挂载凭据服务时，适配器仍读取该环境变量，但登录无法写入新会话。

`/codex-login` 运行 pi-ai 的 ChatGPT 流程（`http://localhost:1455/auth/callback` 上的浏览器回调，或设备码）。提示走 `ctx.userQuestions`；授权 URL 与设备码也会写入宿主日志，也就是打开回调端口的那个进程。没有 `userQuestions` 的无头组合应自行实现 `AuthInteraction` 并调用 `ctx.openaiCodex.login()`，或把紧凑 JSON 会话写入该凭据引用。

`GenerateOptions.provider` 必须是 `openai-codex`。`GenerateOptions.model` 是 `ctx.llm.listModels('openai-codex')` 中的 catalog 模型 id。`GenerateOptions.stop` 以 `UNSUPPORTED_OPTION` 拒绝。

## 动态配置

插件用同一套 `Config` schema 注册 `llm-openai-codex` settings 命名空间。重试策略或显示名变更会就地重新注册已激活的路由。凭据变更（`oauthEnv` 上的 `credentials/updated`）会在不重启的情况下激活或撤回该路由。

## 错误

`NO_ADAPTER` — 路由处于休眠，或请求点名了其他提供方。`UNKNOWN_MODEL` — 模型 id 不在已安装的 Codex catalog 中。`UNSUPPORTED_REASONING_EFFORT` / `UNSUPPORTED_OPTION` / `UNSUPPORTED_CONTENT` — 请求要求了该模型或适配器不提供的能力。`TIMEOUT` / `ABORTED` — 空闲超时或调用方取消。`INVALID_CREDENTIAL` — 已存储文档不是可用的 OAuth 会话。`MISSING_CREDENTIAL` — 登录没有地方持久化会话。

## 模型体验

### 经 pi-ai 发出的提供方请求

#### 模型看到的内容

所选 Codex catalog 模型会收到 `GenerateOptions.system`、历史、工具，以及 pi-ai 通用流式 API 支持的采样字段。本包不添加任何提示散文。

#### Token 影响

精确输入由提供方分词决定。转换不添加模型可见文本。

#### KV Cache 影响

转换保持逻辑请求顺序且不添加文本。更换适配器实例、提供方、模型或任何上游请求 token，都可能从第一处差异起阻止复用。传入 `GenerateOptions.sessionId` 时，除非 pi-ai 内部关闭了 cache retention，Codex 路径可以复用会话缓存。

### 提供方响应

#### 模型看到的内容

pi-ai 事件变为 harness 的 reasoning、text、tool-call、usage 与 finish 分片。工具参数以原始 JSON 字符串存储。

#### Token 影响

生成内容仅在循环记录之后影响后续输入。pi-ai 把推理 token 折入 output usage。

#### KV Cache 影响

已记录的响应内容追加到下一请求，不会使较早可复用前缀失效。

## 已知限制与暂缓事项

- **Models 页面没有登录按钮** — `ui-settings-models` 只编辑 API 密钥卡片。登录入口是 `/codex-login` 或 `ctx.openaiCodex.login()`。专用设置卡片暂缓。
- **登录提示需要 `ctx.userQuestions`** — 没有该服务的组合无法完成 `/codex-login`；请自行提供 `AuthInteraction`，或直接写入会话 JSON。
- **授权 URL 记在宿主日志里** — 浏览器回调监听的是 harness 进程，因此远程 Web 客户端应使用设备码登录，或在同一台机器上运行该命令。
- **不导入 `~/.codex/auth.json`** — 不读取官方 Codex CLI 会话。请通过本插件粘贴或登录。
- **`llm-pi-ai` 会忽略残留的 `openai-codex` profile** — 该路由名由本包占用。请从 `llm-pi-ai:` 节删除该键；它不会再被当成 API 密钥 profile 服务。
