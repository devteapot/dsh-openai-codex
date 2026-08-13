import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { assemble } from './assemble.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Credential } from '@earendil-works/pi-ai'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import * as LlmOpenaiCodex from '@devteapot/dsh-openai-codex'

const { loginMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
}))

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>()
  return {
    ...actual,
    createModels(options?: Parameters<typeof actual.createModels>[0]) {
      const models = actual.createModels(options)
      models.login = async (provider, type, interaction) => {
        const credential = await loginMock(provider, type, interaction) as Credential
        await options?.credentials?.modify(provider, async () => credential)
        return credential
      }
      return models
    },
  }
})
import {
  DEFAULT_OAUTH_ENV,
  PROVIDER,
  serializeOAuthCredential,
} from '@devteapot/dsh-openai-codex'

class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>()

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined || value.length === 0
      ? undefined
      : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.store.get(ref)
    const configured = value !== undefined && value.length === 0 ? false : value !== undefined
    return Promise.resolve({
      configured,
      ...configured ? { source: 'memory' } : {},
      writable: true,
    })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    this.store.set(ref, value)
    this.ctx.emit('credentials/updated', ref)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    if (this.store.delete(ref)) this.ctx.emit('credentials/updated', ref)
    return Promise.resolve()
  }
}

const session = serializeOAuthCredential({
  type: 'oauth',
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
})

afterEach(() => {
  vi.unstubAllEnvs()
  loginMock.mockReset()
})

async function harness(seed: Record<string, string> = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemoryCredentials, seed)
  await ctx.plugin(LlmOpenaiCodex)
  return ctx
}

describe('llm-openai-codex plugin', () => {
  it('stays dormant until an OAuth session is stored, then withdraws on logout', async () => {
    const ctx = await harness()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(await ctx.openaiCodex.status()).toEqual({ configured: false })

    await ctx.credentials.set(DEFAULT_OAUTH_ENV as CredentialRef, session)
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'OpenAI Codex' }])
    })
    expect(await ctx.openaiCodex.status()).toEqual({ configured: true })
    expect((await ctx.llm.listModels(PROVIDER)).length).toBeGreaterThan(0)

    await ctx.openaiCodex.logout()
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders()).toEqual([])
    })
    expect(await ctx.openaiCodex.status()).toEqual({ configured: false })
  })

  it('registers immediately when a session is already stored', async () => {
    const ctx = await harness({ [DEFAULT_OAUTH_ENV]: session })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual([PROVIDER])
    })
  })

  it('serializes credential updates so a stale read cannot restore a withdrawn route', async () => {
    const ctx = await harness()
    await ctx.openaiCodex.status()
    const originalResolve = ctx.credentials.resolve.bind(ctx.credentials)
    let release!: (value: ResolvedCredential | undefined) => void
    const staleRead = new Promise<ResolvedCredential | undefined>((resolve) => { release = resolve })
    const resolve = vi.spyOn(ctx.credentials, 'resolve')
      .mockImplementationOnce(() => staleRead)
      .mockImplementation(ref => originalResolve(ref))

    await ctx.credentials.set(DEFAULT_OAUTH_ENV as CredentialRef, session)
    await vi.waitFor(() => { expect(resolve).toHaveBeenCalledTimes(1) })
    await ctx.credentials.unset(DEFAULT_OAUTH_ENV as CredentialRef)
    release({ value: session, source: 'stale read' })

    await vi.waitFor(() => { expect(resolve).toHaveBeenCalledTimes(2) })
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('registers from an ambient environment session without a credentials seam', async () => {
    vi.stubEnv(DEFAULT_OAUTH_ENV, session)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpenaiCodex)
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual([PROVIDER])
    })
    const hooks = LlmOpenaiCodex.createStoreHooks(ctx, () => LlmOpenaiCodex.resolveAdapterOptions({}))
    const access = hooks.access()
    await expect(access.write('{}')).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    await expect(access.unset()).resolves.toBeUndefined()
  })

  it('removes the route when the contributing fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemoryCredentials, { [DEFAULT_OAUTH_ENV]: session })
    const fiber = await ctx.plugin(LlmOpenaiCodex)
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders()).toHaveLength(1)
    })
    const auth = ctx.openaiCodex
    ctx.emit('credentials/updated', DEFAULT_OAUTH_ENV as CredentialRef)
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    await auth.logout()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('does not publish a route when credential resolution finishes during disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemoryCredentials, { [DEFAULT_OAUTH_ENV]: session })
    const originalResolve = ctx.credentials.resolve.bind(ctx.credentials)
    let release!: (value: ResolvedCredential | undefined) => void
    const delayedRead = new Promise<ResolvedCredential | undefined>((resolve) => { release = resolve })
    const resolve = vi.spyOn(ctx.credentials, 'resolve')
      .mockImplementationOnce(() => delayedRead)
      .mockImplementation(ref => originalResolve(ref))
    const fiber = await ctx.plugin(LlmOpenaiCodex)
    await vi.waitFor(() => { expect(resolve).toHaveBeenCalledOnce() })

    const disposal = fiber.dispose()
    release({ value: session, source: 'delayed read' })
    await disposal

    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('registers slash commands and reports logout success', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemoryCredentials, { [DEFAULT_OAUTH_ENV]: session })
    await ctx.plugin(LlmOpenaiCodex)
    const sessionRecord = ctx.sessions.create(SessionId('cmd'))
    const agent = { id: sessionRecord.id, session: sessionRecord } as Agent
    expect(ctx.commands.list(agent).map(command => command.name))
      .toEqual(['codex-login', 'codex-logout'])
    const logout = await ctx.commands.execute(agent, '/codex-logout extra', new AbortController().signal)
    expect(logout?.result).toEqual({ kind: 'error', text: 'Usage: /codex-logout (no arguments)' })
    const ok = await ctx.commands.execute(agent, '/codex-logout', new AbortController().signal)
    expect(ok?.result).toEqual({ kind: 'success', text: 'Signed out of OpenAI Codex.' })
  })

  it('returns a login error when the OAuth flow rejects', async () => {
    loginMock.mockRejectedValue(new Error('chatgpt unavailable'))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(LlmOpenaiCodex)
    const sessionRecord = ctx.sessions.create(SessionId('cmd'))
    const agent = { id: sessionRecord.id, session: sessionRecord } as Agent
    const result = await ctx.commands.execute(agent, '/codex-login', new AbortController().signal)
    expect(result?.result).toEqual({ kind: 'error', text: 'chatgpt unavailable' })
  })

  it('cancels an in-flight login before command teardown completes', async () => {
    loginMock.mockImplementation((_provider, _type, interaction: { signal?: AbortSignal }) => (
      new Promise((_resolve, reject) => {
        interaction.signal?.addEventListener('abort', () => { reject(new Error('login aborted')) }, { once: true })
      })
    ))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemoryCredentials)
    const fiber = await ctx.plugin(LlmOpenaiCodex)
    const sessionRecord = ctx.sessions.create(SessionId('cmd'))
    const agent = { id: sessionRecord.id, session: sessionRecord } as Agent
    const pending = ctx.commands.execute(agent, '/codex-login', new AbortController().signal)
    await vi.waitFor(() => { expect(loginMock).toHaveBeenCalledOnce() })

    await fiber.dispose()

    await expect(pending).resolves.toMatchObject({
      result: { kind: 'error', text: 'login aborted' },
    })
  })

  it('has no default export', () => {
    expect('default' in LlmOpenaiCodex).toBe(false)
  })

  it('keeps serving when a later registration for the same route is refused', async () => {
    class Dummy extends LlmAdapter {
      async * stream(): AsyncGenerator<never> {}
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(LlmOpenaiCodex)
    ctx.llm.registerAdapter([PROVIDER], new Dummy())
    const error = vi.spyOn(ctx.logger, 'error')
    await ctx.credentials.set(DEFAULT_OAUTH_ENV as CredentialRef, session)
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalled()
    })
  })

  it('persists a mocked login and re-registers after a retry-policy settings change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-settings-'))
    try {
      vi.stubEnv('DSH_HOME', dir)
      await writeFile(join(dir, 'settings.yaml'), '# empty\n')
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MemoryCredentials)
      await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
      await ctx.plugin(LlmOpenaiCodex)
      loginMock.mockResolvedValue({
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: Date.now() + 60_000,
      })
      await ctx.openaiCodex.login({ prompt: async () => 'browser', notify: () => undefined })
      await vi.waitFor(() => {
        expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual([PROVIDER])
      })
      await ctx.settings.update(settingsNamespace('llm-openai-codex'), {
        displayName: 'Codex',
      })
      await vi.waitFor(() => {
        expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'Codex' }])
      })
      ctx.emit('credentials/updated', 'OTHER_REF' as CredentialRef)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports command login success, cancel, and logout failure', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(LlmOpenaiCodex)
    const sessionRecord = ctx.sessions.create(SessionId('cmd'))
    const agent = { id: sessionRecord.id, session: sessionRecord } as Agent
    loginMock.mockResolvedValue({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 60_000,
    })
    const ok = await ctx.commands.execute(agent, '/codex-login', new AbortController().signal)
    expect(ok?.result).toEqual({
      kind: 'success',
      text: 'Signed in to OpenAI Codex. Codex models are available in the model picker.',
    })

    vi.spyOn(ctx.credentials, 'unset').mockRejectedValue(new Error('disk full'))
    const failed = await ctx.commands.execute(agent, '/codex-logout', new AbortController().signal)
    expect(failed?.result.kind).toBe('error')
    expect(failed?.result.kind === 'error' && failed.result.text).toMatch(/disk full/)
    vi.spyOn(ctx.credentials, 'unset').mockRejectedValue('nope')
    const bareLogout = await ctx.commands.execute(agent, '/codex-logout', new AbortController().signal)
    expect(bareLogout?.result.kind === 'error' && bareLogout.result.text).toMatch(/nope/)

    loginMock.mockRejectedValue('bare-string')
    const bare = await ctx.commands.execute(agent, '/codex-login', new AbortController().signal)
    expect(bare?.result).toEqual({ kind: 'error', text: 'bare-string' })
  })

  it('resolves attachments from the plugin context on an image request', async () => {
    const ctx = await harness({ [DEFAULT_OAUTH_ENV]: session })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders()).toHaveLength(1)
    })
    const models = await ctx.llm.listModels(PROVIDER)
    const model = models[0]
    if (model === undefined) throw new Error('expected a Codex catalog model')
    const result = await assemble(ctx, {
      model: model.id,
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: {
          attachmentId: 'sha256:' + 'a'.repeat(64),
          mediaType: 'image/png',
          bytes: 1,
          width: 1,
          height: 1,
        } as never }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish.kind).toBe('error')
  })
})
