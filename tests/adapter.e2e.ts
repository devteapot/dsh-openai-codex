import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmOpenAiCodex from '@devteapot/dsh-openai-codex'
import { PROVIDER } from '@devteapot/dsh-openai-codex'
import { assemble } from './assemble.ts'

const oauthSession = process.env.OPENAI_CODEX_OAUTH
const model = process.env.DSH_OPENAI_CODEX_MODEL ?? 'gpt-5.4-mini'
const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

describe.skipIf(oauthSession === undefined)('llm-openai-codex e2e (real API)', () => {
  it('streams through a credential document and can persist a refreshed session', async () => {
    if (oauthSession === undefined) throw new Error('e2e ran without OPENAI_CODEX_OAUTH')
    const home = await mkdtemp(join(tmpdir(), 'dsh-codex-e2e-'))
    homes.push(home)
    const credentialsPath = join(home, '.credentials.yaml')
    await writeFile(
      credentialsPath,
      `OPENAI_CODEX_OAUTH: ${JSON.stringify(oauthSession)}\n`,
      { mode: 0o600 },
    )
    vi.stubEnv('OPENAI_CODEX_OAUTH', '')
    vi.stubEnv('DSH_HOME', home)

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, { path: credentialsPath, watch: false })
    await ctx.plugin(LlmOpenAiCodex)
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain(PROVIDER)
    })

    const result = await assemble(ctx, {
      provider: PROVIDER,
      model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Reply with exactly the word: pong' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      maxTokens: 128,
    })
    if (result.finish.kind === 'error') {
      throw new Error(`Codex request failed (${result.finish.failure.code}): ${result.finish.failure.message}`)
    }
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .toLowerCase()).toContain('pong')
  })
})
