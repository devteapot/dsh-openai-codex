/**
 * Configuration schema for the OpenAI Codex OAuth adapter. The plugin owns
 * the single `openai-codex` route; this section holds deployment knobs, never
 * the OAuth token. The token lives under {@link Config.oauthEnv}.
 *
 * @module dsh-llm-openai-codex/config
 */

import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** The single provider route this plugin owns. */
export const PROVIDER = 'openai-codex'

/** Selector label for the owned route when {@link Config.displayName} is omitted. */
export const DEFAULT_DISPLAY_NAME = 'OpenAI Codex'

/** Default credential reference storing the serialized OAuth session. */
export const DEFAULT_OAUTH_ENV = 'OPENAI_CODEX_OAUTH'

/** Settings namespace registered on the optional settings seam. */
export const SETTINGS_NS = 'llm-openai-codex'

/** pi-ai thinking levels a profile may name as the deployment default. */
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Credential reference resolved per request; defaults to `OPENAI_CODEX_OAUTH`. */
  oauthEnv?: string
  /** Name shown by selectors; defaults to `OpenAI Codex`. */
  displayName?: string
  /** Deployment default thinking level; omission preserves the provider default. */
  reasoning?: ModelThinkingLevel
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  oauthEnv: z.string().role('credential-ref').default(DEFAULT_OAUTH_ENV),
  displayName: z.string().default(DEFAULT_DISPLAY_NAME),
  reasoning: z.union(REASONING_LEVELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** Validated connection facts captured once per configuration snapshot. */
export interface ResolvedOpenAiCodexOptions {
  /** Credential reference holding the serialized OAuth session. */
  oauthEnv: CredentialRef
  /** Selector label for the owned route. */
  displayName: string
  /** Deployment default thinking level, when configured. */
  reasoning?: ModelThinkingLevel
  /** Positive finite idle budget for one outstanding provider read. */
  streamIdleTimeoutMs: number
  /** Retry policy captured with the route registration. */
  retryPolicy: ResolvedRetryPolicy
}

/**
 * The one explicit resolve step from raw config to validated connection facts.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 */
export function resolveAdapterOptions(config: Config): ResolvedOpenAiCodexOptions {
  const displayName = config.displayName ?? DEFAULT_DISPLAY_NAME
  if (displayName.length === 0) {
    throw new Error('llm-openai-codex: displayName must not be empty')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-openai-codex: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    oauthEnv: credentialRef(config.oauthEnv ?? DEFAULT_OAUTH_ENV),
    displayName,
    ...config.reasoning === undefined ? {} : { reasoning: config.reasoning },
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-openai-codex: retryPolicy'),
  }
}
