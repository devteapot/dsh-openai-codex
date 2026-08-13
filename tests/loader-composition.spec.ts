/**
 * Real-composition guard: LlmRuntime, settings-file, credentials-local, and
 * llm-openai-codex boot from a test-only cordis.yml through Loader + Include.
 * An external credentials-document write publishes the OAuth session and the
 * next listProviders() call sees the live route.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmOpenaiCodex from '@devteapot/dsh-openai-codex'
import {
  DEFAULT_OAUTH_ENV,
  PROVIDER,
  serializeOAuthCredential,
} from '@devteapot/dsh-openai-codex'

const NS = settingsNamespace('llm-openai-codex')
const KEY_REF = credentialRef(DEFAULT_OAUTH_ENV)

const session = serializeOAuthCredential({
  type: 'oauth',
  access: 'boot-access',
  refresh: 'boot-refresh',
  expires: Date.now() + 60_000,
})

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

async function loadComposition(): Promise<{ ctx: Context }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-composition-'))
  vi.stubEnv('DSH_HOME', root)
  const settingsPath = join(root, 'settings.yaml')
  const credentialsPath = join(root, '.credentials.yaml')
  await writeFile(settingsPath, '# personal settings\n')
  await writeFile(credentialsPath, '# empty\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    debounceMs: 10',
    '- id: llm-openai-codex',
    "  name: '@devteapot/dsh-openai-codex'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@devteapot/dsh-openai-codex', LlmOpenaiCodex],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx }
}

describe('llm-openai-codex real composition', () => {
  it('boots from cordis.yml and exposes the route after a credentials write', async () => {
    const { ctx } = await loadComposition()
    expect(ctx.get('settings')!.describe().map(entry => entry.ns)).toEqual([NS])
    expect(ctx.llm.listProviders()).toEqual([])

    await ctx.get('credentials')!.set(KEY_REF, session)
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'OpenAI Codex' }])
    })

    await ctx.get('credentials')!.unset(KEY_REF)
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders()).toEqual([])
    })
  })
})
