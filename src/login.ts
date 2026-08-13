/**
 * Host-side AuthInteraction for `/codex-login`. Prompts go through
 * `ctx.userQuestions` when a UI provider is mounted; notifications go to the
 * host logger so the ChatGPT URL or device code is visible on the process
 * that opened the callback port.
 *
 * @module dsh-llm-openai-codex/login
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import '@deepseek-ai/dsh-user-questions'

/**
 * Build the pi-ai login interaction for one command invocation.
 * @param ctx - context that may carry `userQuestions`.
 * @param invocation - the `/codex-login` invocation supplying the agent and signal.
 * @param ownerSignal - optional host-lifecycle cancellation signal.
 * @returns an interaction the command handler passes to {@link OpenAiCodexAuth.login}.
 */
export function createCommandInteraction(
  ctx: Context,
  invocation: CommandInvocation,
  ownerSignal?: AbortSignal,
): AuthInteraction {
  const signal = ownerSignal === undefined
    ? invocation.signal
    : AbortSignal.any([invocation.signal, ownerSignal])
  return {
    signal,
    notify(event: AuthEvent): void {
      switch (event.type) {
        case 'info':
          ctx.logger.info(event.message)
          for (const link of event.links ?? []) {
            ctx.logger.info(`${link.label ?? 'More information'}: ${link.url}`)
          }
          break
        case 'auth_url':
          ctx.logger.info(event.instructions ?? 'Open this URL to sign in with ChatGPT')
          ctx.logger.info(event.url)
          break
        case 'device_code':
          ctx.logger.info(`Enter code ${event.userCode} at ${event.verificationUri}`)
          break
        case 'progress':
          ctx.logger.info(event.message)
          break
        /* v8 ignore next 4 -- AuthEvent is a closed union */
        default: {
          const _exhaustive: never = event
          void _exhaustive
        }
      }
    },
    async prompt(prompt: AuthPrompt): Promise<string> {
      const questions = ctx.get('userQuestions')
      if (questions === undefined) {
        throw new Error(
          'llm-openai-codex: /codex-login needs ctx.userQuestions; run it from the Web or TUI, or call ctx.openaiCodex.login() with your own interaction',
        )
      }
      const promptSignal = prompt.signal === undefined
        ? signal
        : AbortSignal.any([signal, prompt.signal])
      if (prompt.type === 'select') {
        const answer = await questions.ask({
          questions: [{
            id: 'codex-login-select',
            question: prompt.message,
            options: prompt.options.map(option => ({
              label: option.label,
              ...option.description === undefined ? {} : { description: option.description },
            })),
          }],
          agent: invocation.agent,
          signal: promptSignal,
        })
        const selected = answer.answers[0]?.selected[0]
        const match = prompt.options.find(option => option.label === selected)
        if (match === undefined) {
          throw new Error('llm-openai-codex: login selection was cancelled')
        }
        return match.id
      }
      const answer = await questions.ask({
        questions: [{
          id: 'codex-login-prompt',
          question: prompt.message,
          ...prompt.placeholder === undefined ? {} : { detail: prompt.placeholder },
        }],
        agent: invocation.agent,
        signal: promptSignal,
      })
      const text = answer.answers[0]?.custom ?? answer.answers[0]?.selected[0] ?? ''
      if (text.length === 0 && prompt.type !== 'manual_code') {
        throw new Error('llm-openai-codex: login prompt was cancelled')
      }
      return text
    },
  }
}
