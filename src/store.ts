/**
 * pi-ai `CredentialStore` backed by one harness credential reference.
 * The store holds a single OAuth session for {@link PROVIDER}; every other
 * provider id is absent. `modify` is the only write path so pi-ai can refresh
 * under its lock without this package knowing about token expiry.
 *
 * @module dsh-llm-openai-codex/store
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Credential, CredentialInfo, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import { PROVIDER } from './config.ts'

/** Persistence access captured for one credential-store operation. */
export interface OAuthStoreAccess {
  /**
   * Read the stored serialized session, or `undefined` while unconfigured.
   * @returns the compact JSON session, or `undefined` when absent.
   */
  read(): Promise<string | undefined>
  /**
   * Persist a serialized session.
   * @param value - compact JSON produced by {@link serializeOAuthCredential}.
   */
  write(value: string): Promise<void>
  /** Remove the stored session (logout). */
  unset(): Promise<void>
}

/** Supplies persistence access with one credential reference captured per operation. */
export interface OAuthStoreHooks {
  /**
   * Capture the credential reference and its backing service for one operation.
   * @returns stable persistence access for a read, delete, or modify transaction.
   */
  access(): OAuthStoreAccess
}

/**
 * Serialize one OAuth credential as compact JSON for the credential seam.
 * @param credential - the session pi-ai returned from login or refresh.
 * @returns a single-line JSON document the store can persist.
 */
export function serializeOAuthCredential(credential: OAuthCredential): string {
  return JSON.stringify(credential)
}

/**
 * Parse a stored session. Rejects rather than treating garbage as absent, so a
 * corrupted value cannot silently fall through to "not logged in".
 * @param raw - the stored JSON document.
 * @returns the parsed OAuth credential.
 */
export function parseOAuthCredential(raw: string): OAuthCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (cause) {
    throw new LlmError(
      'llm-openai-codex: stored OAuth session is not JSON; log in again or replace the credential',
      'INVALID_CREDENTIAL',
      { cause },
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LlmError(
      'llm-openai-codex: stored OAuth session must be a JSON object',
      'INVALID_CREDENTIAL',
    )
  }
  const record = parsed as Record<string, unknown>
  if (record.type !== 'oauth'
    || typeof record.access !== 'string'
    || record.access.length === 0
    || typeof record.refresh !== 'string'
    || record.refresh.length === 0
    || typeof record.expires !== 'number'
    || !Number.isFinite(record.expires)) {
    throw new LlmError(
      'llm-openai-codex: stored OAuth session is missing type, access, refresh, or expires',
      'INVALID_CREDENTIAL',
    )
  }
  return record as OAuthCredential
}

/**
 * Build a pi-ai credential store over one harness credential reference.
 * @param hooks - read/write/unset for the serialized session.
 * @returns a store keyed only by {@link PROVIDER}.
 */
export function createOAuthStore(hooks: OAuthStoreHooks): CredentialStore {
  const chains = new Map<string, Promise<unknown>>()
  const enqueue = async <T>(providerId: string, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(providerId) ?? Promise.resolve()
    const next = previous.then(task, task)
    chains.set(providerId, next.then(() => undefined, () => undefined))
    return next
  }

  const readOwned = async (access = hooks.access()): Promise<OAuthCredential | undefined> => {
    const raw = await access.read()
    if (raw === undefined || raw.length === 0) return undefined
    return parseOAuthCredential(raw)
  }

  return {
    async read(providerId: string): Promise<Credential | undefined> {
      if (providerId !== PROVIDER) return undefined
      return readOwned()
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const current = await readOwned()
      return current === undefined ? [] : [{ providerId: PROVIDER, type: 'oauth' }]
    },
    modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
      return enqueue(providerId, async () => {
        if (providerId !== PROVIDER) return undefined
        const access = hooks.access()
        const current = await readOwned(access)
        const next = await fn(current)
        if (next === undefined) return current
        if (next.type !== 'oauth') {
          throw new LlmError(
            'llm-openai-codex: refusing to store a non-OAuth credential on the Codex route',
            'INVALID_CREDENTIAL',
          )
        }
        await access.write(serializeOAuthCredential(next))
        return next
      })
    },
    delete(providerId: string): Promise<void> {
      return enqueue(providerId, async () => {
        if (providerId !== PROVIDER) return
        await hooks.access().unset()
      })
    },
  }
}
