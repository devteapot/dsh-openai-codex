import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_DISPLAY_NAME,
  DEFAULT_OAUTH_ENV,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveAdapterOptions,
} from '@devteapot/dsh-openai-codex'

describe('resolveAdapterOptions', () => {
  it('applies documented defaults', () => {
    const resolved = resolveAdapterOptions({})
    expect(resolved.oauthEnv).toBe(DEFAULT_OAUTH_ENV)
    expect(resolved.displayName).toBe(DEFAULT_DISPLAY_NAME)
    expect(resolved.reasoning).toBeUndefined()
    expect(resolved.streamIdleTimeoutMs).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    expect(resolved.retryPolicy.mode).toBe('normal')
  })

  it('preserves a configured reasoning default', () => {
    expect(resolveAdapterOptions({ reasoning: 'high' }).reasoning).toBe('high')
  })

  it('rejects an empty display name', () => {
    expect(() => resolveAdapterOptions({ displayName: '' })).toThrow(/displayName/)
  })

  it('rejects a non-positive or oversized idle budget', () => {
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: 0 })).toThrow(/streamIdleTimeoutMs/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/streamIdleTimeoutMs/)
  })
})
