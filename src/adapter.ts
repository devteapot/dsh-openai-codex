/**
 * pi-ai-backed adapter for the single `openai-codex` route. A `Models`
 * collection holds the catalog provider plus the harness OAuth store, so
 * login, refresh, and stream share one session. Conversion of harness
 * history and pi-ai events is the same translation `dsh-llm-pi-ai` already
 * verified.
 *
 * @module dsh-llm-openai-codex/adapter
 */

import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { toPiContext, toStreamChunks } from '@deepseek-ai/dsh-llm-pi-ai/conversion'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { PROVIDER } from './config.ts'
import type { ResolvedOpenAiCodexOptions } from './config.ts'

/**
 * Build the pi-ai collection this adapter streams through: one Codex provider
 * and the harness-owned credential store.
 * @param store - OAuth session storage keyed by {@link PROVIDER}.
 * @returns a mutable collection the plugin and tests can share.
 */
export function createCodexModels(store: CredentialStore): MutableModels {
  const models = createModels({ credentials: store })
  models.setProvider(openaiCodexProvider())
  return models
}

/** Constructor options for {@link OpenAiCodexAdapter}. */
export interface OpenAiCodexAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => ResolvedOpenAiCodexOptions
  /** pi-ai collection holding the Codex provider and OAuth store. */
  models: () => Models
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
}

function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `openai-codex model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

function streamOptions(
  reasoning: ModelThinkingLevel | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    maxRetries: 0,
  }
}

/**
 * Single-route Codex adapter. Each operation reads the current options and
 * collection, so a login, logout, or settings change reaches the next request
 * without a restart; an in-flight stream keeps the facts it started with.
 */
export class OpenAiCodexAdapter extends LlmAdapter {
  constructor(private readonly config: OpenAiCodexAdapterOptions) {
    super()
  }

  private modelOf(models: Models, model: string): Model<Api> {
    const resolved = models.getModel(PROVIDER, model)
    if (resolved === undefined) {
      throw new LlmError(`openai-codex has no catalog model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.config.options().displayName }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      if (provider !== PROVIDER) {
        throw new LlmError(`openai-codex adapter does not own provider "${provider}"`, 'NO_ADAPTER')
      }
      return this.config.models().getModels(PROVIDER).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      if (provider !== PROVIDER) {
        throw new LlmError(`openai-codex adapter does not own provider "${provider}"`, 'NO_ADAPTER')
      }
      const options = this.config.options()
      const resolvedModel = this.modelOf(this.config.models(), model)
      const defaultLevel = describableReasoningLevel(resolvedModel, options.reasoning)
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        inputModalities: [...resolvedModel.input],
        context: { contextWindow: resolvedModel.contextWindow },
        ...reasoningInfo(resolvedModel, defaultLevel),
      }
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== PROVIDER) {
      throw new LlmError(`openai-codex adapter does not own provider "${options.provider}"`, 'NO_ADAPTER')
    }
    if (options.stop !== undefined) {
      throw new LlmError('llm-openai-codex does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const connection = this.config.options()
    const models = this.config.models()
    const model = this.modelOf(models, options.model)
    const reasoning = resolveReasoningLevel(model, options.reasoningEffort ?? connection.reasoning)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = connection.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`openai-codex model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('openai-codex image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const context = attachments === undefined
        ? toPiContext(options)
        : await toPiContext(options, attachments)
      const events = models.streamSimple(model, context, {
        ...streamOptions(reasoning),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        headers: attributionHeaders(),
      })
      const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          /* v8 ignore next -- idle expiry is classified after next() returns */
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('openai-codex stream consumer stopped')
          try {
            await iterator.return(undefined)
          /* v8 ignore next 3 -- return-time abort cannot add an outcome */
          } catch (_abortedSdkTeardown) {
          }
        }
      }
    } catch (error: unknown) {
      /* v8 ignore next 6 -- idle expiry needs a signal-honoring provider read; faux factories do not */
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(
          `openai-codex stream idle timeout after ${streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('openai-codex request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('openai-codex stream consumer stopped')
    }
  }
}
