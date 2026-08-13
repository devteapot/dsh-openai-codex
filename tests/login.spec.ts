import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createCommandInteraction } from '@devteapot/dsh-openai-codex'

function invocation(signal = new AbortController().signal): CommandInvocation {
  return {
    commandId: 'cmd_1' as CommandInvocation['commandId'],
    agent: { id: 'agent-1' } as Agent,
    rawInput: '',
    signal,
  }
}

describe('createCommandInteraction', () => {
  it('logs every notification kind', () => {
    const ctx = new Context()
    const info = vi.spyOn(ctx.logger, 'info')
    const interaction = createCommandInteraction(ctx, invocation())
    interaction.notify({ type: 'info', message: 'hello', links: [{ url: 'https://example.test', label: 'Docs' }] })
    interaction.notify({ type: 'info', message: 'plain', links: [{ url: 'https://example.test/x' }] })
    interaction.notify({ type: 'info', message: 'nolinks' })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example/login', instructions: 'Open ChatGPT' })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example/login' })
    interaction.notify({
      type: 'device_code',
      userCode: 'ABCD',
      verificationUri: 'https://auth.example/device',
    })
    interaction.notify({ type: 'progress', message: 'waiting' })
    expect(info.mock.calls.flat()).toEqual(expect.arrayContaining([
      'hello',
      'Docs: https://example.test',
      'More information: https://example.test/x',
      'Open ChatGPT',
      'https://auth.example/login',
      'Enter code ABCD at https://auth.example/device',
      'waiting',
    ]))
  })

  it('refuses a prompt when userQuestions is not mounted', async () => {
    const ctx = new Context()
    const interaction = createCommandInteraction(ctx, invocation())
    await expect(interaction.prompt({ type: 'text', message: 'code?' }))
      .rejects.toThrow(/userQuestions/)
  })

  it('maps a select label back to the option id', async () => {
    const ctx = new Context()
    const ask = vi.fn(async () => ({
      answers: [{ id: 'codex-login-select', selected: ['Browser'] }],
    }))
    Object.assign(ctx, { userQuestions: { ask } })
    vi.spyOn(ctx, 'get').mockImplementation((name: string) => name === 'userQuestions' ? { ask } : undefined)
    const interaction = createCommandInteraction(ctx, invocation())
    await expect(interaction.prompt({
      type: 'select',
      message: 'How to sign in?',
      options: [
        { id: 'browser', label: 'Browser', description: 'Local callback' },
        { id: 'device_code', label: 'Device code' },
      ],
    })).resolves.toBe('browser')
  })

  it('rejects a cancelled select or empty text prompt', async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce({ answers: [{ id: 'codex-login-select', selected: [] }] })
      .mockResolvedValueOnce({ answers: [{ id: 'codex-login-prompt', selected: [] }] })
    const ctx = new Context()
    vi.spyOn(ctx, 'get').mockImplementation((name: string) => name === 'userQuestions' ? { ask } : undefined)
    const interaction = createCommandInteraction(ctx, invocation())
    await expect(interaction.prompt({
      type: 'select',
      message: 'How?',
      options: [{ id: 'browser', label: 'Browser' }],
    })).rejects.toThrow(/cancelled/)
    await expect(interaction.prompt({ type: 'secret', message: 'paste' }))
      .rejects.toThrow(/cancelled/)
  })

  it('accepts custom text and an empty manual_code (callback won)', async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce({ answers: [{ id: 'codex-login-prompt', selected: [], custom: 'code-value' }] })
      .mockResolvedValueOnce({ answers: [{ id: 'codex-login-prompt', selected: [] }] })
    const ctx = new Context()
    vi.spyOn(ctx, 'get').mockImplementation((name: string) => name === 'userQuestions' ? { ask } : undefined)
    const interaction = createCommandInteraction(ctx, invocation())
    await expect(interaction.prompt({
      type: 'text',
      message: 'paste',
      placeholder: 'url',
      signal: new AbortController().signal,
    })).resolves.toBe('code-value')
    await expect(interaction.prompt({ type: 'manual_code', message: 'or wait' }))
      .resolves.toBe('')
  })

  it('shows the authorization URL instead of the callback placeholder', async () => {
    const ask = vi.fn(async () => ({
      answers: [{ id: 'codex-login-prompt', selected: [] }],
    }))
    const ctx = new Context()
    vi.spyOn(ctx, 'get').mockImplementation((name: string) => name === 'userQuestions' ? { ask } : undefined)
    const interaction = createCommandInteraction(ctx, invocation())
    const authorizationUrl = 'https://auth.openai.com/oauth/authorize?state=correct'
    interaction.notify({ type: 'auth_url', url: authorizationUrl })

    await interaction.prompt({
      type: 'manual_code',
      message: 'Complete login',
      placeholder: 'http://localhost:1455/auth/callback',
    })

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      questions: [{
        id: 'codex-login-prompt',
        question: 'Complete login',
        detail: authorizationUrl,
      }],
    }))
  })
})
