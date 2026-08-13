import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { PROVIDER } from '@devteapot/dsh-openai-codex'
import { createOAuthStore, parseOAuthCredential, serializeOAuthCredential } from '@devteapot/dsh-openai-codex'

const session: OAuthCredential = {
  type: 'oauth',
  access: 'access-token',
  refresh: 'refresh-token',
  expires: 1_700_000_000_000,
}

function memoryHooks(initial?: string) {
  let value = initial
  return {
    hooks: {
      access: () => ({
        read: () => Promise.resolve(value),
        write: (next: string) => {
          value = next
          return Promise.resolve()
        },
        unset: () => {
          value = undefined
          return Promise.resolve()
        },
      }),
    },
    get: () => value,
  }
}

describe('parseOAuthCredential', () => {
  it('round-trips a compact session', () => {
    expect(parseOAuthCredential(serializeOAuthCredential(session))).toEqual(session)
  })

  it('rejects non-JSON', () => {
    expect(() => parseOAuthCredential('not-json')).toThrow(LlmError)
    try {
      parseOAuthCredential('not-json')
    } catch (error) {
      expect((error as LlmError).code).toBe('INVALID_CREDENTIAL')
    }
  })

  it('rejects a non-object document', () => {
    expect(() => parseOAuthCredential('[]')).toThrow(/JSON object/)
    expect(() => parseOAuthCredential('null')).toThrow(/JSON object/)
  })

  it('rejects a document missing OAuth fields', () => {
    expect(() => parseOAuthCredential(JSON.stringify({ type: 'api_key', key: 'x' })))
      .toThrow(/missing type, access, refresh, or expires/)
    expect(() => parseOAuthCredential(JSON.stringify({ type: 'oauth', access: '', refresh: 'r', expires: 1 })))
      .toThrow(/missing type/)
    expect(() => parseOAuthCredential(JSON.stringify({ type: 'oauth', access: 'a', refresh: '', expires: 1 })))
      .toThrow(/missing type/)
    expect(() => parseOAuthCredential(JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: Number.NaN })))
      .toThrow(/missing type/)
  })
})

describe('createOAuthStore', () => {
  it('reads, lists, and deletes only the openai-codex route', async () => {
    const { hooks } = memoryHooks(serializeOAuthCredential(session))
    const store = createOAuthStore(hooks)
    expect(await store.read('openai')).toBeUndefined()
    expect(await store.read(PROVIDER)).toEqual(session)
    expect(await store.list()).toEqual([{ providerId: PROVIDER, type: 'oauth' }])
    await store.delete('openai')
    expect(await store.read(PROVIDER)).toEqual(session)
    await store.delete(PROVIDER)
    expect(await store.read(PROVIDER)).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('treats an empty stored value as absent', async () => {
    const store = createOAuthStore(memoryHooks('').hooks)
    expect(await store.read(PROVIDER)).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('serializes modify under the store lock and ignores undefined returns', async () => {
    const { hooks, get } = memoryHooks(serializeOAuthCredential(session))
    const store = createOAuthStore(hooks)
    const left = await store.modify(PROVIDER, async existing => existing)
    expect(left).toEqual(session)
    expect(get()).toBe(serializeOAuthCredential(session))
    expect(await store.modify(PROVIDER, async () => undefined)).toEqual(session)
    const next: OAuthCredential = { ...session, access: 'rotated' }
    const written = await store.modify(PROVIDER, async () => next)
    expect(written).toEqual(next)
    expect(await store.read(PROVIDER)).toEqual(next)
    expect(await store.modify('other', async () => next)).toBeUndefined()
  })

  it('refuses to persist a non-OAuth credential', async () => {
    const store = createOAuthStore(memoryHooks().hooks)
    await expect(store.modify(PROVIDER, async () => ({ type: 'api_key', key: 'sk' })))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('keeps one persistence reference for an entire modify operation', async () => {
    const values = new Map([
      ['old', serializeOAuthCredential(session)],
      ['new', undefined],
    ])
    let current = 'old'
    let markAccessed!: () => void
    const accessed = new Promise<void>((resolve) => { markAccessed = resolve })
    let release!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const store = createOAuthStore({
      access: () => {
        const captured = current
        markAccessed()
        return {
          read: () => Promise.resolve(values.get(captured)),
          write: (value) => {
            values.set(captured, value)
            return Promise.resolve()
          },
          unset: () => {
            values.delete(captured)
            return Promise.resolve()
          },
        }
      },
    })
    const rotated = { ...session, access: 'rotated' }
    const modifying = store.modify(PROVIDER, async () => {
      await paused
      return rotated
    })
    await accessed
    current = 'new'
    release()

    await expect(modifying).resolves.toEqual(rotated)
    expect(values.get('old')).toBe(serializeOAuthCredential(rotated))
    expect(values.get('new')).toBeUndefined()
  })
})
