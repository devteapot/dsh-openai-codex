# @devteapot/dsh-openai-codex

English | [中文](README.zh.md)

ChatGPT Plus/Pro OAuth adapter for the harness LLM seam. One plugin instance owns the `openai-codex` provider route, stores the OAuth session under a credential reference, and streams through pi-ai's Codex catalog provider. Login, refresh, and logout stay in this package so `@deepseek-ai/dsh-llm-pi-ai` can keep its key-and-endpoint profiles.

The package root exposes the Cordis plugin contract, `OpenAiCodexAdapter`, `OpenAiCodexAuth` (`ctx.openaiCodex`), `createCodexModels`, and the OAuth store helpers. History and event translation reuse `toPiContext` / `toStreamChunks` from `dsh-llm-pi-ai`'s `./conversion` subpath.

## Install

This development release requires the accompanying DeepSeek Harness change that exports `@deepseek-ai/dsh-llm-pi-ai/conversion`. No published harness build provides that subpath yet; the peer range starts at the expected `0.1.0-rc.7` release so incompatible installations fail during dependency resolution instead of at runtime.

Install a commit-pinned copy into a profile:

```sh
dsh plugin --profile web add github:devteapot/dsh-openai-codex#<commit>
```

Git dependencies run this repository's `prepare` build. pnpm 10 and newer require explicit permission before running it. If the first install reports a blocked build, add the exact package key it prints to `$DSH_HOME/profiles/web/pnpm-workspace.yaml`, then repeat the command:

```yaml
allowBuilds:
  '@devteapot/dsh-openai-codex': true
```

The package declares `dsh.bundle`, so `dsh plugin add` tracks it in the profile manifest and applies `cordis.patch.yml`. Remove it with `dsh plugin --profile web remove @devteapot/dsh-openai-codex`.

## Config

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

The route stays **dormant** until the referenced credential holds a JSON OAuth session (`type`, `access`, `refresh`, `expires`). `/codex-login` and `ctx.openaiCodex.login(interaction)` persist that session; `/codex-logout` and `ctx.openaiCodex.logout()` remove it. pi-ai refreshes an expiring token on the next request under the store lock. A request made while logged out fails with `NO_ADAPTER` because the route is not registered; `MISSING_CREDENTIAL` is reserved for a login that cannot persist the session (no credentials service).

`oauthEnv` is a credential *reference*. The settings document never holds the token. Without a mounted credentials service the adapter still reads the named environment variable, but login cannot store a new session.

`/codex-login` runs the pi-ai ChatGPT flow (browser callback on `http://localhost:1455/auth/callback`, or device code). Prompts go through `ctx.userQuestions`; the authorization URL and device code are also written to the host logger, which is the process that opened the callback port. Headless compositions without `userQuestions` should call `ctx.openaiCodex.login()` with their own `AuthInteraction`, or write a compact JSON session to the credential reference.

`GenerateOptions.provider` must be `openai-codex`. `GenerateOptions.model` is a catalog model id from `ctx.llm.listModels('openai-codex')`. `GenerateOptions.stop` is rejected with `UNSUPPORTED_OPTION`.

## Dynamic configuration

The plugin registers the `llm-openai-codex` settings namespace with this same `Config` schema. A changed retry policy or display name re-registers the live route in place. Credential changes (`credentials/updated` on `oauthEnv`) activate or withdraw the route without a restart.

## Errors

`NO_ADAPTER` — the route is dormant or the request named another provider. `UNKNOWN_MODEL` — the model id is not in the installed Codex catalog. `UNSUPPORTED_REASONING_EFFORT` / `UNSUPPORTED_OPTION` / `UNSUPPORTED_CONTENT` — the request asked for a capability this model or adapter does not serve. `TIMEOUT` / `ABORTED` — idle expiry or caller cancel. `INVALID_CREDENTIAL` — the stored document is not a usable OAuth session. `MISSING_CREDENTIAL` — login has nowhere to persist the session.

## Model Experience

### Provider request through pi-ai

#### What the model sees

The selected Codex catalog model receives `GenerateOptions.system`, history, tools, and the sampling fields pi-ai's common streaming API supports. This package adds no prompt prose.

#### Token effect

Provider tokenization governs exact input. Conversion adds no model-visible text.

#### KV Cache effect

Conversion preserves logical request order without adding text. Changing adapter instance, provider, model, or any upstream request token may prevent reuse from the first difference. Passing `GenerateOptions.sessionId` lets pi-ai's Codex path reuse a session cache unless cache retention is disabled inside pi-ai.

### Provider response

#### What the model sees

pi-ai events become harness reasoning, text, tool-call, usage, and finish chunks. Tool arguments are stored as raw JSON strings.

#### Token effect

Generated content affects later inputs only after the loop records it. pi-ai folds reasoning tokens into output usage.

#### KV Cache effect

Recorded response content appends to the next request and does not invalidate its earlier reusable prefix.

## Known Limitations and Deferred Work

- **The Models page has no Sign-in button** — `ui-settings-models` only edits API-key cards. Login is `/codex-login` or `ctx.openaiCodex.login()`. A dedicated settings card is deferred.
- **Login prompts need `ctx.userQuestions`** — a composition without that service cannot complete `/codex-login`; supply an `AuthInteraction` or write the session JSON yourself.
- **The authorization URL is logged on the host** — the browser callback listens on the harness process, so a remote Web client must use device-code login or run the command on the same machine.
- **No import of `~/.codex/auth.json`** — the official Codex CLI session is not read. Paste or login through this plugin.
- **`llm-pi-ai` ignores a leftover `openai-codex` profile** — that route name is reserved here. Remove the key from the `llm-pi-ai:` section; it is not served as an API-key profile.
