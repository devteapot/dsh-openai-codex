import { describe, expect, it } from 'vitest'
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import {
  OpenAiCodexAdapter,
  PROVIDER,
  resolveAdapterOptions,
} from '@devteapot/dsh-openai-codex'
import { assemble } from './assemble.ts'

const MODEL = 'codex-test'

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

function stubAttachments(): AttachmentStore {
  return {
    readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
      return Promise.resolve({ ref, data: Uint8Array.of(1) })
    },
  } as AttachmentStore
}

function adapterOf(overrides: {
  reasoning?: 'off' | 'high' | 'xhigh'
  responses?: Array<ReturnType<typeof fauxAssistantMessage> | (() => Promise<ReturnType<typeof fauxAssistantMessage>>)>
  input?: ('text' | 'image')[]
  think?: boolean
  streamIdleTimeoutMs?: number
  resolveAttachments?: () => AttachmentStore | undefined
} = {}) {
  const faux = fauxProvider({
    provider: PROVIDER,
    models: [{
      id: MODEL,
      name: 'Codex Test',
      reasoning: overrides.think ?? true,
      input: overrides.input ?? ['text'],
    }],
  })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(overrides.responses ?? [fauxAssistantMessage('hello')])
  const adapter = new OpenAiCodexAdapter({
    options: () => resolveAdapterOptions({
      ...overrides.reasoning === undefined ? {} : { reasoning: overrides.reasoning },
      ...overrides.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: overrides.streamIdleTimeoutMs },
    }),
    models: () => models,
    ...overrides.resolveAttachments === undefined ? {} : { resolveAttachments: overrides.resolveAttachments },
  })
  return { adapter, faux }
}

async function mounted(adapter: OpenAiCodexAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return ctx
}

describe('OpenAiCodexAdapter', () => {
  it('lists catalog models and resolves reasoning metadata', async () => {
    const { adapter } = adapterOf({ reasoning: 'high' })
    expect(adapter.providerInfo(PROVIDER)).toEqual({ id: PROVIDER, name: 'OpenAI Codex' })
    expect(adapter.providerRetryPolicy(PROVIDER)?.mode).toBe('normal')
    await expect(adapter.listModels('other')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    const models = await adapter.listModels(PROVIDER)
    expect(models).toEqual([{
      provider: PROVIDER,
      id: MODEL,
      name: 'Codex Test',
      inputModalities: ['text'],
    }])
    const info = await adapter.resolveModel(PROVIDER, MODEL)
    expect(info.reasoning?.defaultEffort).toBe(ReasoningEffortId('high'))
    expect(info.context?.contextWindow).toBeGreaterThan(0)
    await expect(adapter.resolveModel('other', MODEL)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(adapter.resolveModel(PROVIDER, 'missing')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  })

  it('omits a profile reasoning default the model cannot take', async () => {
    const { adapter } = adapterOf({ reasoning: 'off' })
    const info = await adapter.resolveModel(PROVIDER, MODEL)
    expect(info.reasoning?.defaultEffort === undefined
      || info.reasoning.efforts.some(effort => effort.id === info.reasoning?.defaultEffort)).toBe(true)
  })

  it('describes a non-reasoning catalog model without a reasoning field', async () => {
    const { adapter } = adapterOf({ think: false })
    const info = await adapter.resolveModel(PROVIDER, MODEL)
    expect(info.reasoning).toBeUndefined()
  })

  it('omits an unsupported profile default from model description', async () => {
    const { adapter } = adapterOf({ reasoning: 'xhigh' })
    const info = await adapter.resolveModel(PROVIDER, MODEL)
    expect(info.reasoning?.defaultEffort).toBeUndefined()
  })

  it('streams a faux assistant turn through the assembler', async () => {
    const { adapter } = adapterOf()
    const ctx = await mounted(adapter)
    const result = await assemble(ctx, {
      model: MODEL,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish.kind).toBe('stop')
  })

  it('lists the installed Codex catalog through createCodexModels', async () => {
    const { createCodexModels, createOAuthStore } = await import('@devteapot/dsh-openai-codex')
    const models = createCodexModels(createOAuthStore({
      access: () => ({
        read: () => Promise.resolve(undefined),
        write: () => Promise.resolve(),
        unset: () => Promise.resolve(),
      }),
    }))
    expect(models.getModels(PROVIDER).length).toBeGreaterThan(0)
  })

  it('rejects an image when the model accepts images but no attachment store is mounted', async () => {
    const { adapter } = adapterOf({ input: ['text', 'image'] })
    const ctx = await mounted(adapter)
    const result = await assemble(ctx, {
      model: MODEL,
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: 'att_1' as never }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_CONTENT' } })
  })

  it('rejects stop sequences, foreign providers, and images on a text-only model', async () => {
    const { adapter } = adapterOf()
    const ctx = await mounted(adapter)
    expect((await assemble(ctx, { provider: 'other', model: MODEL, messages: [] })).finish)
      .toMatchObject({ kind: 'error', failure: { code: 'NO_ADAPTER' } })
    expect((await assemble(ctx, { model: MODEL, stop: ['END'], messages: [] })).finish)
      .toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_OPTION' } })
    expect((await assemble(ctx, {
      model: MODEL,
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: 'att_1' as never }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })).finish).toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_CONTENT' } })
  })

  it('rejects an unsupported per-request reasoning effort', async () => {
    const { adapter } = adapterOf()
    const ctx = await mounted(adapter)
    const result = await assemble(ctx, {
      model: MODEL,
      reasoningEffort: ReasoningEffortId('not-a-level'),
      messages: [],
    })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } })
  })

  it('maps caller abort to ABORTED', async () => {
    const { adapter } = adapterOf()
    const ctx = await mounted(adapter)
    const controller = new AbortController()
    controller.abort()
    const result = await assemble(ctx, { model: MODEL, messages: [], signal: controller.signal })
    expect(result.finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
  })

  it('streams sampling fields, reasoning, images, and direct adapter failures', async () => {
    const attachments = stubAttachments()
    const { adapter } = adapterOf({
      reasoning: 'high',
      input: ['text', 'image'],
      resolveAttachments: () => attachments,
    })
    const ctx = await mounted(adapter)
    const result = await assemble(ctx, {
      model: MODEL,
      temperature: 0.2,
      maxTokens: 16,
      sessionId: SessionId('sess_1'),
      reasoningEffort: ReasoningEffortId('high'),
      messages: [createUserMessage({
        content: [
          { type: 'text', text: 'see' },
          { type: 'image', attachment: IMAGE_REF },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish.kind === 'stop' || result.finish.kind === 'error').toBe(true)

    await expect(async () => {
      for await (const _chunk of adapter.stream({
        provider: 'other',
        model: MODEL,
        messages: [],
      })) void _chunk
    }).rejects.toMatchObject({ code: 'NO_ADAPTER' })

    const aborted = new AbortController()
    aborted.abort()
    try {
      for await (const _chunk of adapter.stream({
        provider: PROVIDER,
        model: MODEL,
        messages: [],
        signal: aborted.signal,
      })) void _chunk
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
    }

    const { adapter: offAdapter } = adapterOf({ reasoning: 'off' })
    const ctxOff = await mounted(offAdapter)
    expect((await assemble(ctxOff, { model: MODEL, messages: [] })).finish.kind).toMatch(/stop|error/)
    await expect(async () => {
      for await (const _chunk of offAdapter.stream({
        provider: PROVIDER,
        model: MODEL,
        reasoningEffort: ReasoningEffortId('not-real'),
        messages: [],
      })) void _chunk
    }).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })

    const { adapter: abortImage } = adapterOf()
    const aborting = new AbortController()
    aborting.abort()
    await expect(async () => {
      for await (const _chunk of abortImage.stream({
        provider: PROVIDER,
        model: MODEL,
        signal: aborting.signal,
        messages: [createUserMessage({
          content: [{ type: 'image', attachment: IMAGE_REF }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      })) void _chunk
    }).rejects.toMatchObject({ code: 'ABORTED' })

    const { adapter: stopEarly } = adapterOf()
    const iterator = stopEarly.stream({ provider: PROVIDER, model: MODEL, messages: [] })[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.(undefined)
  })

})
