import { Context, Service } from "@deepseek-ai/cordis";
import { GenerateOptions, LlmAdapter, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from "@deepseek-ai/dsh-llm";
import { AuthInteraction, CredentialStore, ModelThinkingLevel, Models, MutableModels, OAuthCredential } from "@earendil-works/pi-ai";
import z from "@deepseek-ai/schemastery";
import { CredentialRef } from "@deepseek-ai/dsh-credentials";
import "@deepseek-ai/dsh-user-questions";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { CommandInvocation } from "@deepseek-ai/dsh-commands";
//#region src/config.d.ts
/** Default maximum idle interval while an adapter stream read is outstanding. */
declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** The single provider route this plugin owns. */
declare const PROVIDER = "openai-codex";
/** Selector label for the owned route when {@link Config.displayName} is omitted. */
declare const DEFAULT_DISPLAY_NAME = "OpenAI Codex";
/** Default credential reference storing the serialized OAuth session. */
declare const DEFAULT_OAUTH_ENV = "OPENAI_CODEX_OAUTH";
/** Settings namespace registered on the optional settings seam. */
declare const SETTINGS_NS = "llm-openai-codex";
/** Plugin config, validated by the same-named schemastery schema. */
interface Config {
  /** Credential reference resolved per request; defaults to `OPENAI_CODEX_OAUTH`. */
  oauthEnv?: string;
  /** Name shown by selectors; defaults to `OpenAI Codex`. */
  displayName?: string;
  /** Deployment default thinking level; omission preserves the provider default. */
  reasoning?: ModelThinkingLevel;
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number;
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig;
}
/** Runtime schema for {@link Config}. */
declare const Config: z<Config>;
/** Validated connection facts captured once per configuration snapshot. */
interface ResolvedOpenAiCodexOptions {
  /** Credential reference holding the serialized OAuth session. */
  oauthEnv: CredentialRef;
  /** Selector label for the owned route. */
  displayName: string;
  /** Deployment default thinking level, when configured. */
  reasoning?: ModelThinkingLevel;
  /** Positive finite idle budget for one outstanding provider read. */
  streamIdleTimeoutMs: number;
  /** Retry policy captured with the route registration. */
  retryPolicy: ResolvedRetryPolicy;
}
/**
 * The one explicit resolve step from raw config to validated connection facts.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 */
declare function resolveAdapterOptions(config: Config): ResolvedOpenAiCodexOptions;
//#endregion
//#region src/store.d.ts
/** Persistence access captured for one credential-store operation. */
interface OAuthStoreAccess {
  /**
   * Read the stored serialized session, or `undefined` while unconfigured.
   * @returns the compact JSON session, or `undefined` when absent.
   */
  read(): Promise<string | undefined>;
  /**
   * Persist a serialized session.
   * @param value - compact JSON produced by {@link serializeOAuthCredential}.
   */
  write(value: string): Promise<void>;
  /** Remove the stored session (logout). */
  unset(): Promise<void>;
}
/** Supplies persistence access with one credential reference captured per operation. */
interface OAuthStoreHooks {
  /**
   * Capture the credential reference and its backing service for one operation.
   * @returns stable persistence access for a read, delete, or modify transaction.
   */
  access(): OAuthStoreAccess;
}
/**
 * Serialize one OAuth credential as compact JSON for the credential seam.
 * @param credential - the session pi-ai returned from login or refresh.
 * @returns a single-line JSON document the store can persist.
 */
declare function serializeOAuthCredential(credential: OAuthCredential): string;
/**
 * Parse a stored session. Rejects rather than treating garbage as absent, so a
 * corrupted value cannot silently fall through to "not logged in".
 * @param raw - the stored JSON document.
 * @returns the parsed OAuth credential.
 */
declare function parseOAuthCredential(raw: string): OAuthCredential;
/**
 * Build a pi-ai credential store over one harness credential reference.
 * @param hooks - read/write/unset for the serialized session.
 * @returns a store keyed only by {@link PROVIDER}.
 */
declare function createOAuthStore(hooks: OAuthStoreHooks): CredentialStore;
//#endregion
//#region src/adapter.d.ts
/**
 * Build the pi-ai collection this adapter streams through: one Codex provider
 * and the harness-owned credential store.
 * @param store - OAuth session storage keyed by {@link PROVIDER}.
 * @returns a mutable collection the plugin and tests can share.
 */
declare function createCodexModels(store: CredentialStore): MutableModels;
/** Constructor options for {@link OpenAiCodexAdapter}. */
interface OpenAiCodexAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => ResolvedOpenAiCodexOptions;
  /** pi-ai collection holding the Codex provider and OAuth store. */
  models: () => Models;
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined;
}
/**
 * Single-route Codex adapter. Each operation reads the current options and
 * collection, so a login, logout, or settings change reaches the next request
 * without a restart; an in-flight stream keeps the facts it started with.
 */
declare class OpenAiCodexAdapter extends LlmAdapter {
  private readonly config;
  constructor(config: OpenAiCodexAdapterOptions);
  private modelOf;
  providerInfo(provider: string): LlmProviderInfo;
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//#endregion
//#region src/login.d.ts
/**
 * Build the pi-ai login interaction for one command invocation.
 * @param ctx - context that may carry `userQuestions`.
 * @param invocation - the `/codex-login` invocation supplying the agent and signal.
 * @param ownerSignal - optional host-lifecycle cancellation signal.
 * @returns an interaction the command handler passes to {@link OpenAiCodexAuth.login}.
 */
declare function createCommandInteraction(ctx: Context, invocation: CommandInvocation, ownerSignal?: AbortSignal): AuthInteraction;
//#endregion
//#region src/index.d.ts
declare const name = "llm-openai-codex";
declare const inject: string[];
declare module '@deepseek-ai/cordis' {
  interface Context {
    openaiCodex: OpenAiCodexAuth;
  }
}
/** Login, logout, and status for the ChatGPT OAuth session this plugin stores. */
declare class OpenAiCodexAuth extends Service {
  private readonly ops;
  constructor(ctx: Context, ops: {
    login: (interaction: AuthInteraction) => Promise<void>;
    logout: () => Promise<void>;
    status: () => Promise<{
      configured: boolean;
    }>;
  });
  /**
   * Run the Codex OAuth login and persist the returned session.
   * @param interaction - prompts and notifications the host UI implements.
   * @returns after the session is stored and the route is registered.
   */
  login(interaction: AuthInteraction): Promise<void>;
  /**
   * Drop the stored session and withdraw the `openai-codex` route.
   * @returns after the credential is removed and the route is withdrawn.
   */
  logout(): Promise<void>;
  /**
   * Report whether a stored OAuth session currently exists.
   * @returns `{ configured: true }` when the store can read a session.
   */
  status(): Promise<{
    configured: boolean;
  }>;
}
/**
 * Persistence hooks that read the OAuth session from `ctx.credentials` or the
 * launch environment, and write only through the credentials service.
 * @param ctx - context that may carry `credentials`.
 * @param options - current validated connection facts.
 * @returns hooks for {@link createOAuthStore}.
 */
declare function createStoreHooks(ctx: Context, options: () => ResolvedOpenAiCodexOptions): OAuthStoreHooks;
/**
 * Register the Codex adapter, OAuth service, and optional `/codex-login`
 * / `/codex-logout` commands.
 * @param ctx - context carrying `ctx.llm` and optional settings/credentials/commands.
 * @param config - composition entry config, used as the settings base.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, DEFAULT_DISPLAY_NAME, DEFAULT_OAUTH_ENV, DEFAULT_STREAM_IDLE_TIMEOUT_MS, type OAuthStoreAccess, type OAuthStoreHooks, OpenAiCodexAdapter, type OpenAiCodexAdapterOptions, OpenAiCodexAuth, PROVIDER, type ResolvedOpenAiCodexOptions, SETTINGS_NS, apply, createCodexModels, createCommandInteraction, createOAuthStore, createStoreHooks, inject, name, parseOAuthCredential, resolveAdapterOptions, serializeOAuthCredential };
//# sourceMappingURL=index.d.ts.map